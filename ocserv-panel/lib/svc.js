'use strict';
// ============================================================================
//  服务管理后端抽象：systemd（Debian/Ubuntu） / OpenRC（Alpine）
//  面板只依赖这里的几个函数，不再直接调 systemctl
// ============================================================================
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function which(bin) {
  const dirs = String(process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(':');
  for (const d of dirs) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return path.join(d, bin); } catch (e) { /* 继续找 */ }
  }
  return '';
}

const HAS_SYSTEMD = !!which('systemctl') && fs.existsSync('/run/systemd/system');
const HAS_OPENRC = !HAS_SYSTEMD && !!which('rc-service');
const BACKEND = HAS_SYSTEMD ? 'systemd' : (HAS_OPENRC ? 'openrc' : 'none');

function exec(file, args, timeout) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { timeout: timeout || 15000, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: out || '', err: err || '' });
    });
  });
}

async function active(name) {
  if (BACKEND === 'systemd') return (await exec('systemctl', ['is-active', name])).out.trim();
  if (BACKEND === 'openrc') {
    const r = await exec('rc-service', [name, 'status']);
    const t = (r.out || '') + (r.err || '');
    if (r.code === 0) return 'active';
    if (/crashed/i.test(t)) return 'failed';
    return 'inactive';
  }
  return '';
}

async function enabled(name) {
  if (BACKEND === 'systemd') return (await exec('systemctl', ['is-enabled', name])).out.trim();
  if (BACKEND === 'openrc') {
    const r = await exec('rc-update', ['show']);
    const re = new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|');
    return (r.out || '').split('\n').some((l) => re.test(l)) ? 'enabled' : 'disabled';
  }
  return '';
}

// systemd 的 show 一大串属性；OpenRC 下拼出等价的几个字段
async function show(name) {
  if (BACKEND === 'systemd') {
    const r = await exec('systemctl', ['show', name,
      '--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts']);
    const p = {};
    (r.out || '').split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) p[l.slice(0, i)] = l.slice(i + 1); });
    return p;
  }
  const st = await active(name);
  const p = { ActiveState: st, SubState: st === 'active' ? 'running' : (st || 'unknown'), MainPID: '' };
  for (const f of ['/run/' + name + '.pid']) {
    try {
      const pid = String(fs.readFileSync(f, 'utf8')).trim();
      if (pid && fs.existsSync('/proc/' + pid)) p.MainPID = pid;
    } catch (e) { /* 没有 pidfile */ }
  }
  return p;
}

// verb: start | stop | restart | reload | reload-or-restart
async function action(verb, name) {
  if (BACKEND === 'systemd') return exec('systemctl', [verb, name], 30000);
  if (BACKEND !== 'openrc') {
    return { code: 1, out: '', err: '未找到服务管理器（systemd / OpenRC 都不存在）' };
  }
  if (verb === 'reload-or-restart') {
    const r = await exec('rc-service', [name, 'reload'], 30000);
    if (r.code === 0) return r;
    return exec('rc-service', [name, 'restart'], 30000);
  }
  return exec('rc-service', [name, verb], 30000);
}

async function enable(name, startNow) {
  if (BACKEND === 'systemd') {
    const a = startNow ? ['enable', '--now', name] : ['enable', name];
    return exec('systemctl', a, 30000);
  }
  if (BACKEND === 'openrc') {
    const r = await exec('rc-update', ['add', name, 'default'], 30000);
    if (startNow) await action('start', name);
    return r;
  }
  return { code: 1, out: '', err: '未找到服务管理器' };
}

async function disable(name, stopNow) {
  if (BACKEND === 'systemd') return exec('systemctl', stopNow ? ['disable', '--now', name] : ['disable', name], 30000);
  if (BACKEND === 'openrc') {
    if (stopNow) await action('stop', name);
    return exec('rc-update', ['del', name, 'default'], 30000);
  }
  return { code: 1, out: '', err: '未找到服务管理器' };
}

async function daemonReload() {
  if (BACKEND !== 'systemd') return { code: 0, out: '', err: '' };
  return exec('systemctl', ['daemon-reload'], 30000);
}

// NAT 单元的落盘路径（systemd 单元 / OpenRC 脚本）
function natUnitPath() {
  return BACKEND === 'openrc' ? '/etc/init.d/ocserv-nat' : '/etc/systemd/system/ocserv-nat.service';
}

// 装好 NAT 单元并立即启用
async function natInstall(unitText, name) {
  const p = natUnitPath();
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) { /* ignore */ }
  fs.writeFileSync(p, unitText, { mode: BACKEND === 'openrc' ? 0o755 : 0o644 });
  try { fs.chmodSync(p, BACKEND === 'openrc' ? 0o755 : 0o644); } catch (e) { /* ignore */ }
  await daemonReload();
  return enable(name, true);
}

// 给 acme.sh 用的重载命令
function reloadCmd(name) {
  if (BACKEND === 'openrc') return 'rc-service ' + name + " reload 2>/dev/null || rc-service " + name + ' restart';
  return 'systemctl reload ' + name + ' 2>/dev/null || true';
}

async function logs(name, n) {
  const lines = Math.min(Math.max(Number(n) || 200, 10), 2000);
  if (BACKEND === 'systemd') {
    const r = await exec('journalctl', ['-u', name, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
    return (r.out || r.err || '').trim();
  }
  // OpenRC：优先读 init 脚本里的 output_log，其次 syslog
  const f = '/var/log/' + name + '.log';
  try {
    const all = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return all.slice(-lines).join('\n');
  } catch (e) { /* 读不到就试 logread */ }
  const r = await exec('logread', []);
  const sel = (r.out || '').split('\n').filter((l) => l.indexOf(name) >= 0);
  return sel.slice(-lines).join('\n') || '（没有日志：' + f + ' 不存在，syslog 里也没有 ' + name + ' 的记录）';
}

function logsHint(name) {
  return BACKEND === 'openrc'
    ? 'rc-service ' + name + ' status / tail -n 50 /var/log/' + name + '.log'
    : 'systemctl status ' + name + ' / journalctl -u ' + name + ' -n 50';
}

module.exports = {
  BACKEND, HAS_SYSTEMD, HAS_OPENRC,
  active, enabled, show, action, enable, disable,
  daemonReload, natUnitPath, natInstall, reloadCmd, logs, logsHint
};
