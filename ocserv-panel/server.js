#!/usr/bin/env node
'use strict';
/*
 * ocserv 管理面板 —— 通用版 (零第三方依赖, Node >= 18)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * 通过同目录 config.json 配置:
 *   port / host / https / certFile / keyFile
 *   ocservConf / ocpasswd / ocservService
 *   acmeDomain / acmeBin / acmeServer / renewScript / renewLog
 *
 * 首次启动自动生成随机管理员密码 -> admin-cred.txt
 * 改密码/改端口: 面板「面板设置」页；也可命令行
 *                node server.js --set-password <用户> <新密码>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BASE       = __dirname;
const CONF_FILE  = path.join(BASE, 'config.json');
const PUBLIC_DIR = path.join(BASE, 'public');
const CRED_FILE  = path.join(BASE, 'admin-cred.txt');
const VERSION    = '1.6.1';

// 可在面板上一键开关的 ocserv 布尔选项（白名单，只碰这几项）
const OPTION_KEYS = {
  'cisco-client-compat': { label: 'AnyConnect 兼容模式', desc: '开启后 Cisco AnyConnect / 兼容客户端（含 OpenConnect 的 anyconnect 协议）可正常连接；关闭则只按标准 OpenConnect 协议协商。', def: false },
  'dtls-legacy':         { label: '兼容旧版 DTLS', desc: '老客户端无法协商 DTLS1.2 时回落到旧版本，兼容性更好。', def: true },
  'try-mtu-discovery':   { label: 'MTU 自动发现', desc: '自动探测可用 MTU，避免大包不通（建议保持开启）。', def: true },
  'tunnel-all-dns':      { label: 'DNS 全部走隧道', desc: '客户端把全部 DNS 解析都发给 VPN 下发的服务器。', def: true },
  'deny-roaming':        { label: '禁止漫游', desc: '客户端 IP 变化（切换网络）立即断开，更严格。', def: false },
  'ping-leases':         { label: '下发地址前 ping 探测', desc: '分配 IP 前先探测是否占用，避免地址冲突（大网络才需要）。', def: false }
};

const DEFAULTS = {
  title: 'ocserv 管理面板',
  port: 19999,
  host: '0.0.0.0',
  https: false,
  // 证书与域名留空，由面板「配置向导」填写
  certFile: '',
  keyFile:  '',
  ocservConf: '/etc/ocserv/ocserv.conf',
  ocpasswd: '/etc/ocserv/ocpasswd',
  ocservBin: '/usr/sbin/ocserv',
  ocservService: 'ocserv',
  acmeDomain: '',
  acmeBin: '/root/.acme.sh/acme.sh',
  acmeServer: 'https://acme-v02.api.letsencrypt.org/directory',
  renewScript: '/usr/local/bin/acme-renew.sh',
  renewLog: '/var/log/acme-renew.log'
};

const SESSION_TTL = 12 * 3600 * 1000;
const MAX_BODY    = 4 * 1024 * 1024;
const MAX_FAILS   = 5;
const FAIL_WINDOW = 10 * 60 * 1000;
const PANEL_USER  = 'admin';
// 面板自身 systemd 服务名（仅用于提示与改端口后的自动重启判断）
const PANEL_SERVICE = process.env.PANEL_SERVICE || 'ocserv-panel';

/* ------------------------------------------------------------------ 配置 */

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verifyPassword(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const calc = crypto.scryptSync(pw, rec.salt, 64);
  const stored = Buffer.from(rec.hash, 'hex');
  return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
}
function saveConfig(cfg) { fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); }

function credText(cfg, user, pw) {
  return 'ocserv 管理面板账号\n' +
    'URL:      ' + (cfg.https ? 'https' : 'http') + '://' + displayHost(cfg) + ':' + cfg.port + '/\n' +
    '用户名:   ' + user + '\n' +
    '密码:     ' + pw + '\n' +
    '改密码:   面板「面板设置」页；或 node ' + __filename + ' --set-password ' + user + ' <新密码>' +
    '（面板正在运行时需 systemctl restart ' + PANEL_SERVICE + ' 才生效）\n';
}
function writeCredFile(cfg, user, pw) {
  try { fs.writeFileSync(CRED_FILE, credText(cfg, user, pw), { mode: 0o600 }); } catch (e) {}
}

function loadConfig() {
  let cfg = {};
  let fresh = false;
  try { cfg = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) || {}; }
  catch (e) { fresh = true; }

  for (const k of Object.keys(DEFAULTS)) if (cfg[k] === undefined) cfg[k] = DEFAULTS[k];
  if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');

  let initPw = null;
  if (!cfg.users || !Object.keys(cfg.users).length) {
    initPw = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    cfg.users = { [PANEL_USER]: hashPassword(initPw) };
    fresh = true;
  }
  saveConfig(cfg);

  if (fresh && initPw) {
    writeCredFile(cfg, PANEL_USER, initPw);
    console.log('[panel] 初始管理员账号已生成 -> ' + CRED_FILE);
    console.log('[panel] 用户名: ' + PANEL_USER + '  密码: ' + initPw);
  }
  return cfg;
}
function displayHost(cfg) { return (cfg.host === '0.0.0.0' || cfg.host === '::') ? os.hostname() : cfg.host; }

// node server.js --set-password <user> <password>
if (process.argv[2] === '--set-password') {
  const user = process.argv[3], pw = process.argv[4];
  if (!user || !pw) { console.error('用法: node server.js --set-password <用户名> <新密码>'); process.exit(2); }
  const cfg = loadConfig();
  cfg.users[user] = hashPassword(pw);
  saveConfig(cfg);
  writeCredFile(cfg, user, pw);
  console.log('已设置 ' + user + ' 的密码');
  console.log('提示: 若面板正在运行, 需 systemctl restart ' + PANEL_SERVICE + ' 后新密码才生效（或在面板「面板设置」页改，立即生效）');
  process.exit(0);
}

const CFG = loadConfig();

/* ------------------------------------------------------------- 基础工具 */

// systemd 启动的服务里往往没有 HOME/PATH；而 acme.sh 的工作目录是 $HOME/.acme.sh，
// 缺了 HOME 它会去用 /.acme.sh 这个空目录(于是丢掉已注册的账号、回落到 ZeroSSL)。
// 所以所有子进程都统一补上基础环境。
function baseEnv(extra) {
  const e = Object.assign({}, process.env, extra || {});
  if (!e.HOME) e.HOME = (typeof os.homedir === 'function' && os.homedir()) || '/root';
  if (!e.PATH) e.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return e;
}
function run(cmd, args, input, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    let done = false;
    const p = spawn(cmd, args || [], { stdio: ['pipe', 'pipe', 'pipe'], env: baseEnv(extraEnv) });
    let out = '', err = '';
    const timer = setTimeout(() => { if (!done) { try { p.kill('SIGKILL'); } catch (e) {} } }, timeoutMs || 20000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String((e && e.message) || e) }); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
    try { p.stdin.on('error', () => {}); if (input !== undefined && input !== null) p.stdin.write(input); p.stdin.end(); } catch (e) {}
  });
}
function readText(file, dflt) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return dflt === undefined ? null : dflt; } }
function fileInfo(p) {
  try { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtime.toISOString() }; }
  catch (e) { return null; }
}

const sessions = new Map();
const failures = new Map();
function newSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { user, csrf, exp: Date.now() + SESSION_TTL });
  return { token, csrf };
}
function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); });
  return out;
}
function getSession(req) {
  const c = parseCookies(req.headers.cookie);
  const s = sessions.get(c.sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(c.sid); return null; }
  s.exp = Date.now() + SESSION_TTL;
  return s;
}
function clientIp(req) { return (req.socket && req.socket.remoteAddress) || '-'; }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of failures) if (v.until < now && v.count === 0) failures.delete(k);
}, 60000).unref();

/* --------------------------------------------------------- ocserv 操作层 */

async function ocservStatus() {
  const show = await run('systemctl', ['show', CFG.ocservService,
    '--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts']);
  const p = {};
  show.out.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) p[l.slice(0, i)] = l.slice(i + 1); });

  const verRaw = await run(CFG.ocservBin, ['--version']);           // 注意: 版本信息走 stderr
  const version = ((verRaw.out || '') + (verRaw.err || '')).split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';

  const listen = [];
  (readText(CFG.ocservConf, '') || '').split('\n').forEach((l) => {
    const m = l.match(/^\s*(tcp-port|udp-port)\s*=\s*(\d+)/);
    if (m) listen.push({ proto: m[1].split('-')[0].toUpperCase(), port: Number(m[2]) });
  });
  return { ...p, active: await systemctlActive(), version, listen };
}
async function systemctlActive() {
  const r = await run('systemctl', ['is-active', CFG.ocservService]);
  return (r.out || '').trim();
}
function readUsers() {
  // ocpasswd 行格式: 用户名:组:密码哈希    (无组时写 '*')
  return (readText(CFG.ocpasswd, '') || '').split('\n')
    .filter((l) => l.trim() && l.includes(':'))
    .map((l) => {
      const parts = l.split(':');
      const group = parts[1] && parts[1] !== '*' ? parts[1] : '';
      return { name: parts[0], group, hasHash: !!parts.slice(2).join(':') };
    });
}
function validName(n) { return typeof n === 'string' && /^[A-Za-z0-9._@-]{1,32}$/.test(n); }

async function addUser(name, password) {
  if (!validName(name)) return { ok: false, error: '用户名只允许字母/数字/._@- ，最长 32 位' };
  if (typeof password !== 'string' || password.length < 6) return { ok: false, error: '密码至少 6 位' };
  // ocpasswd 交互式读取密码两次；无 tty 时从 stdin 读
  const r = await run('ocpasswd', ['-c', CFG.ocpasswd, name], password + '\n' + password + '\n');
  if (!readUsers().some((u) => u.name === name)) {
    return { ok: false, error: 'ocpasswd 写入失败: ' + (r.err || r.out || '未知错误').trim() };
  }
  return { ok: true };
}
async function delUser(name) {
  if (!validName(name)) return { ok: false, error: '非法用户名' };
  const r = await run('ocpasswd', ['-c', CFG.ocpasswd, '-d', name]);
  if (readUsers().some((u) => u.name === name)) return { ok: false, error: '删除失败: ' + (r.err || r.out || '').trim() };
  return { ok: true };
}
async function getSessions() {
  const j = await run('occtl', ['-j', 'show', 'users']);
  const jt = (j.out || '').trim();
  if (jt.startsWith('[') || jt.startsWith('{')) {
    try {
      const parsed = JSON.parse(jt);
      return { json: true, list: Array.isArray(parsed) ? parsed : (parsed.users || []) };
    } catch (e) {}
  }
  // JSON 不可用（老版本 occtl 或异常）：原样把文本交给前端显示，不做易错的列猜测
  const t = await run('occtl', ['show', 'users']);
  const txt = ((t.out || '') + (t.err || '')).trim();
  if (!txt) return { json: false, list: [], error: 'occtl 无输出（ocserv 未运行？）' };
  return { json: false, list: [], raw: txt };
}
/* ---- ocserv.conf 布尔开关 ---- */
function readOptions() {
  const txt = readText(CFG.ocservConf, '') || '';
  return Object.keys(OPTION_KEYS).map((key) => {
    const meta = OPTION_KEYS[key];
    const m = txt.match(new RegExp('^[ \\t]*#?[ \\t]*' + key + '[ \\t]*=[ \\t]*(\\S+)', 'm'));
    const present = !!m;
    const value = m ? /^(true|yes|1)$/i.test(m[1]) : meta.def;
    return { key, label: meta.label, desc: meta.desc, value, present, isDefault: !present };
  });
}

/* ---- 认证方式（本地密码文件 / PAM）---- */
// ocserv 不允许同时配置多个密码类认证方法（同时配会直接拒绝启动），
// 所以"切换"= 替换那一行，而不是叠加。certificate / enable-auth 等非密码类保持原样。
const PASSWORD_AUTH_METHODS = ['plain', 'pam', 'radius', 'gssapi', 'oidc'];

function parseAuthLine(line) {
  const m = String(line).match(/^\s*auth\s*=\s*"([^"]*)"/);
  if (!m) return null;
  const raw = m[1];
  const br = raw.indexOf('[');
  const name = (br >= 0 ? raw.slice(0, br) : raw).trim().toLowerCase();
  const kv = {};
  if (br >= 0) {
    raw.slice(br + 1).replace(/\]\s*$/, '').split(',').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) kv[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
  }
  return { name, kv, raw };
}
function authState() {
  const txt = readText(CFG.ocservConf, '') || '';
  const list = txt.split('\n').map(parseAuthLine).filter(Boolean);
  const pw = list.filter((a) => PASSWORD_AUTH_METHODS.indexOf(a.name) >= 0);
  const cur = pw[0] || list[0] || null;
  return {
    method: cur ? cur.name : null,
    raw: cur ? cur.raw : null,
    others: list.filter((a) => a !== cur).map((a) => a.name),
    pam: cur && cur.name === 'pam' ? { service: cur.kv.service || '', gidMin: cur.kv['gid-min'] || '' } : null,
    methods: list.map((a) => a.name)
  };
}
// 要写进配置的值必须限制字符集：带了 ] 或 " 就能插出新的配置项
function validPamService(v) { return /^[A-Za-z0-9._@-]{1,64}$/.test(v); }
function renderAuthLine(method, o) {
  if (method === 'plain') return 'auth = "plain[passwd=' + CFG.ocpasswd + ']"';
  const parts = [];
  if (o.service) parts.push('service=' + o.service);
  if (o.gidMin) parts.push('gid-min=' + o.gidMin);
  return 'auth = "pam' + (parts.length ? '[' + parts.join(',') + ']' : '') + '"';
}

async function setAuthMethod(body) {
  const method = String(body.method || '');
  if (method !== 'plain' && method !== 'pam') return { ok: false, error: '不支持的认证方式: ' + method };
  const txt = readText(CFG.ocservConf, null);
  if (txt === null) return { ok: false, error: '读不到配置文件 ' + CFG.ocservConf };

  let service = '', gidMin = '';
  if (method === 'pam') {
    service = String(body.service || '').trim();
    gidMin = String(body.gidMin || '').trim();
    if (service && !validPamService(service)) return { ok: false, error: 'PAM 服务名不合法（只允许字母/数字/._@-，最长 64）' };
    if (gidMin && !/^\d{1,9}$/.test(gidMin)) return { ok: false, error: 'gid-min 必须是数字' };
  }

  const newLine = renderAuthLine(method, { service, gidMin });
  const out = [];
  let placed = false;
  for (const l of txt.split('\n')) {
    const a = parseAuthLine(l);
    if (a && PASSWORD_AUTH_METHODS.indexOf(a.name) >= 0) {
      if (!placed) { out.push(newLine); placed = true; }   // 写回原位置，其余密码类 auth 行删掉
      continue;
    }
    out.push(l);
  }
  if (!placed) {                                            // 原本没有密码类 auth 行：插在注释头之后
    let i = 0;
    while (i < out.length && /^\s*(#|$)/.test(out[i])) i++;
    out.splice(i, 0, newLine);
  }
  const updated = out.join('\n');
  if (updated === txt) return { ok: true, changed: false, auth: authState() };

  const bak = CFG.ocservConf + '.bak-' + Date.now();
  try { fs.copyFileSync(CFG.ocservConf, bak); } catch (e) {}
  fs.writeFileSync(CFG.ocservConf, updated, { mode: 0o644 });

  const t = await run(CFG.ocservBin, ['-c', CFG.ocservConf, '--test-config'], null, 20000);
  if (t.code !== 0) {
    try { fs.copyFileSync(bak, CFG.ocservConf); } catch (e) {}
    return { ok: false, error: '配置校验失败，已回滚：' + ((t.err || t.out) || '').trim() };
  }
  // 主进程收到 SIGHUP 会给 sec-mod 发信号，认证配置会重新加载
  const rl = await run('systemctl', ['reload-or-restart', CFG.ocservService], null, 30000);
  return { ok: true, changed: true, backup: bak, auth: authState(), out: ((rl.out || '') + (rl.err || '')).trim() };
}

async function setOption(key, value) {
  if (!OPTION_KEYS[key]) return { ok: false, error: '不支持的选项: ' + key };
  const txt = readText(CFG.ocservConf, null);
  if (txt === null) return { ok: false, error: '读不到配置文件 ' + CFG.ocservConf };

  const lineRe = new RegExp('^[ \\t]*#?[ \\t]*' + key + '[ \\t]*=[^\\n]*$', 'm');
  const newLine = key + ' = ' + (value ? 'true' : 'false');
  const updated = lineRe.test(txt)
    ? txt.replace(lineRe, newLine)
    : txt.replace(/[\s]*$/, '') + '\n' + newLine + '\n';
  if (updated === txt) return { ok: true, changed: false };

  const bak = CFG.ocservConf + '.bak-' + Date.now();
  try { fs.copyFileSync(CFG.ocservConf, bak); } catch (e) {}
  fs.writeFileSync(CFG.ocservConf, updated, { mode: 0o644 });

  const t = await run(CFG.ocservBin, ['-c', CFG.ocservConf, '--test-config'], null, 20000);
  if (t.code !== 0) {
    try { fs.copyFileSync(bak, CFG.ocservConf); } catch (e) {}
    return { ok: false, error: '配置校验失败，已回滚：' + ((t.err || t.out) || '').trim() };
  }
  // SIGHUP 热重载（不断线）；个别选项可能需重启才完全生效
  const rl = await run('systemctl', ['reload', CFG.ocservService], null, 30000);
  return { ok: true, changed: true, backup: bak, out: ((rl.out || '') + (rl.err || '')).trim() };
}

async function certInfo() {
  const cert = { exists: false, files: [] };
  try { if (!fs.existsSync(CFG.certFile)) return cert; } catch (e) { return cert; }
  cert.exists = true;
  cert.files = [fileInfo(CFG.certFile), fileInfo(CFG.keyFile), fileInfo(path.join(path.dirname(CFG.certFile), 'ca.pem'))].filter(Boolean);
  const r = await run('openssl', ['x509', '-in', CFG.certFile, '-noout', '-subject', '-issuer', '-dates', '-ext', 'subjectAltName']);
  const out = r.out || '';
  const get = (re) => { const m = out.match(re); return m ? m[1].trim() : ''; };
  cert.subject = get(/subject\s*=\s*(.+)/);
  cert.issuer = get(/issuer\s*=\s*(.+)/);
  cert.notBefore = get(/notBefore\s*=\s*(.+)/);
  cert.notAfter = get(/notAfter\s*=\s*(.+)/);
  const san = (out.match(/DNS:[^\s,]+/g) || []).map((s) => s.replace('DNS:', ''));
  cert.san = san;
  if (cert.notAfter) {
    const end = new Date(cert.notAfter);
    if (!isNaN(end.getTime())) cert.daysLeft = Math.floor((end.getTime() - Date.now()) / 86400000);
  }
  const ac = readText(path.join(path.dirname(CFG.acmeBin), CFG.acmeDomain + '_ecc', CFG.acmeDomain + '.conf'), '') || '';
  const nm = ac.match(/Le_NextRenewTimeStr='([^']+)'/);
  if (nm) cert.nextRenew = nm[1];
  cert.reloadCmd = /Le_ReloadCmd/.test(ac);
  return cert;
}
async function renew(force) {
  if (force) {
    const r = await run(CFG.acmeBin, ['--renew', '--force', '-d', CFG.acmeDomain, '--server', CFG.acmeServer], null, 90000);
    await run('systemctl', ['reload', CFG.ocservService]);
    return { ok: r.code === 0, out: ((r.out || '') + (r.err || '')).trim().split('\n').slice(-12).join('\n') };
  }
  const r = await run(CFG.renewScript, [], null, 90000);
  const log = (readText(CFG.renewLog, '') || '').trim().split('\n').slice(-15).join('\n');
  return { ok: r.code === 0, out: log };
}
function systemInfo() {
  let up = 0;
  try { up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch (e) {}
  const mem = os.totalmem(), free = os.freemem();
  return {
    hostname: os.hostname(), platform: os.platform() + ' ' + os.release(), uptime: Math.floor(up),
    loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
    mem: { total: mem, used: mem - free, percent: Math.round(((mem - free) / mem) * 100) },
    nodeVersion: process.version
  };
}

/* ============================================================ 首次配置向导 */

const TPL_DIR   = path.join(BASE, 'templates');
const DNS_ENV   = '/etc/ocserv/acme-dns.env';
const NAT_UNIT  = '/etc/systemd/system/ocserv-nat.service';
const PANEL_SVC = 'ocserv-panel';
const ACME_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/acmesh-official/acme.sh@master/',
  'https://ghfast.top/https://raw.githubusercontent.com/acmesh-official/acme.sh/master/',
  'https://gitee.com/neilpang/acme.sh/raw/master/'
];
// 常用 DNS 服务商(其余可用“自定义”填插件名 + KEY=VALUE)
const DNS_PROVIDERS = [
  { id: 'cf',   name: 'Cloudflare',        fields: [{ k: 'CF_Token', label: 'API Token' }, { k: 'CF_Account_ID', label: 'Account ID(可空)' }] },
  { id: 'ali',  name: '阿里云 DNS',         fields: [{ k: 'Ali_Key', label: 'AccessKey ID' }, { k: 'Ali_Secret', label: 'AccessKey Secret' }] },
  { id: 'dp',   name: 'DNSPod / 腾讯云',    fields: [{ k: 'DP_Id', label: 'ID' }, { k: 'DP_Key', label: 'Token' }] },
  { id: 'gd',   name: 'GoDaddy',           fields: [{ k: 'GD_Key', label: 'Key' }, { k: 'GD_Secret', label: 'Secret' }] },
  { id: 'dgon', name: 'DigitalOcean',      fields: [{ k: 'DO_API_KEY', label: 'API Token' }] }
];

function tpl(name) { return readText(path.join(TPL_DIR, name), null); }
// 纯函数(模板渲染 / 网段换算 / systemd 单元)集中在 lib/tpl.js，便于脱离 Linux 单独测试
const TPL = require('./lib/tpl');
const fillTpl = TPL.fillTpl;
function tailOf(r, n) { return String(((r && r.out) || '') + ((r && r.err) || '')).trim().split('\n').slice(-(n || 8)).join('\n'); }
function writeAs(p, data, mode) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, data, { mode: mode || 0o644 });
  try { fs.chmodSync(p, mode || 0o644); } catch (e) {}
}
const validDomain = TPL.validDomain;
const isIp = TPL.isIp;
const maskBits = TPL.maskBits;

async function detectOutIf() {
  const r = await run('bash', ['-c', "ip -4 route show default 2>/dev/null | awk '{print $5}' | head -1"]);
  return (r.out || '').trim() || 'eth0';
}

async function setupStatus() {
  const hasConf = !!fileInfo(CFG.ocservConf);
  const cert = await certInfo();
  const st = await ocservStatus();
  const en = (await run('systemctl', ['is-enabled', CFG.ocservService])).out || '';
  return {
    initialized: hasConf && cert.exists,
    hasConf, certExists: cert.exists, cert,
    service: { active: st.active, sub: st.SubState, enabled: en.trim(), version: st.version },
    hasNAT: !!fileInfo(NAT_UNIT),
    acmeInstalled: !!fileInfo(CFG.acmeBin),
    panel: { port: CFG.port, host: CFG.host, service: PANEL_SVC },
    outIf: await detectOutIf(),
    templates: { ok: tpl('ocserv.conf.tpl') !== null, dir: TPL_DIR },
    providers: DNS_PROVIDERS,
    presets: { vpnPort: 443, vpnNet: '10.66.66.0', vpnMask: '255.255.255.0', dns1: '1.1.1.1', dns2: '8.8.8.8', dnssleep: 30 }
  };
}

async function ensureAcme(L, email) {
  if (fileInfo(CFG.acmeBin)) { L('acme.sh 已存在: ' + CFG.acmeBin); return true; }
  L('未装 acme.sh，依次尝试镜像下载…');
  let ok = false;
  for (const base of ACME_MIRRORS) {
    const url = base + 'acme.sh';
    L('  拉取 ' + url);
    const r = await run('curl', ['-fsSL', '-m', '60', '-o', '/tmp/acme.sh', url], null, 90000);
    if (r.code === 0 && String(readText('/tmp/acme.sh', '')).indexOf('#!/usr/bin/env sh') === 0) { ok = true; break; }
  }
  if (!ok) { L('  x 下载失败（三个镜像都不通）'); return false; }
  await run('chmod', ['755', '/tmp/acme.sh']);
  // 注意: acme.sh 安装时按“相对文件名”复制自己，必须在 /tmp 里执行
  const cmd = email
    ? 'cd /tmp && ./acme.sh --install --accountemail "$EMAIL"'
    : 'cd /tmp && ./acme.sh --install';
  const r2 = await run('bash', ['-c', cmd], null, 120000, { EMAIL: email || '' });
  if (r2.code !== 0 || !fileInfo(CFG.acmeBin)) { L('  x 安装失败:\n' + tailOf(r2)); return false; }
  L('  v acme.sh 安装完成');
  return true;
}

async function setAcmeEmail(L, email) {
  await run(CFG.acmeBin, ['--set-default-ca', '--server', CFG.acmeServer], null, 30000);
  if (!email) { L('未填账号邮箱：将注册“无联系邮箱”的账号（收不到到期提醒，续期仍由 cron 负责）'); return; }
  const up = await run(CFG.acmeBin, ['--update-account', '--accountemail', email], null, 60000);
  if (up.code === 0) { L('账号邮箱已更新: ' + email); return; }
  const ac = path.join(path.dirname(CFG.acmeBin), 'account.conf');
  let t = readText(ac, null);
  if (t === null) { L('! 找不到 ' + ac + '，邮箱未设置'); return; }
  if (/^ACCOUNT_EMAIL=/m.test(t)) t = t.replace(/^ACCOUNT_EMAIL=.*$/m, "ACCOUNT_EMAIL='" + email + "'");
  else t = t.replace(/\s*$/, '') + "\nACCOUNT_EMAIL='" + email + "'\n";
  writeAs(ac, t, 0o600);
  L('账号邮箱已设置: ' + email);
}

async function ensureDnsapi(plugin, L) {
  const dir = path.join(path.dirname(CFG.acmeBin), 'dnsapi');
  const file = path.join(dir, plugin + '.sh');
  const mark = plugin + '_add()';
  if (String(readText(file, '')).indexOf(mark) >= 0) { L('插件已存在: ' + file); return true; }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  for (const base of ACME_MIRRORS) {
    const url = base + 'dnsapi/' + plugin + '.sh';
    L('  拉取 ' + plugin + '.sh ← ' + url);
    const r = await run('curl', ['-fsSL', '-m', '60', '-o', file, url], null, 90000);
    if (r.code === 0 && String(readText(file, '')).indexOf(mark) >= 0) {
      try { fs.chmodSync(file, 0o644); } catch (e) {}
      L('  v 插件就绪');
      return true;
    }
  }
  try { fs.unlinkSync(file); } catch (e) {}
  L('  x 无法获取 DNS 插件 ' + plugin + '（请换个镜像或手动放到 ' + dir + '）');
  return false;
}

async function runIssue(L, opt, env) {
  const domain = opt.domain;
  const certDir = '/etc/ssl/securev/' + domain;
  L('证书目录: ' + certDir);
  // acme.sh 的 --install-cert 不会自己建父目录，必须先建好（否则它直接返回 1）
  try { fs.mkdirSync(certDir, { recursive: true }); } catch (e) {}
  const sc = await run(CFG.acmeBin, ['--set-default-ca', '--server', CFG.acmeServer], null, 30000, env);
  if (sc.code !== 0) L('! 设置默认 CA 失败: ' + tailOf(sc, 4));
  const args = ['--issue', '--server', CFG.acmeServer];
  if (opt.mode === 'dns') args.push('--dns', 'dns_' + opt.provider, '--dnssleep', String(opt.dnssleep || 30));
  else args.push('--standalone');
  args.push('-d', domain, '--keylength', 'ec-256');
  L('签发: acme.sh ' + args.join(' '));
  const r1 = await run(CFG.acmeBin, args, null, 300000, env);
  if (r1.code === 2) L('  证书仍有效，跳过签发 (acme.sh RENEW_SKIP=2)');
  else if (r1.code !== 0) { L('  x 签发失败:\n' + tailOf(r1, 20)); return false; }
  else L('  v 签发成功');
  const ic = await run(CFG.acmeBin, ['--install-cert', '-d', domain,
    '--key-file', certDir + '/privkey.pem', '--fullchain-file', certDir + '/fullchain.pem',
    '--cert-file', certDir + '/cert.pem', '--ca-file', certDir + '/ca.pem',
    '--reloadcmd', 'systemctl reload ocserv 2>/dev/null || true'], null, 120000, env);
  // 全新部署时 ocserv 还没启动，reloadcmd 会失败 —— 这时 acme.sh 返回非 0 但证书已经写好了，
  // 所以判据是“文件到底写没写”，而不是退出码。
  if (ic.code !== 0) {
    if (fileInfo(certDir + '/fullchain.pem')) {
      L('  ! install-cert 返回 ' + ic.code + '（证书已写入；一般是 reloadcmd 时 ocserv 未运行，可忽略）');
    } else {
      L('  x install-cert 失败（exit=' + ic.code + '）：');
      tailOf(ic, 8).split('\n').forEach((x) => L('    ' + x));
      return false;
    }
  }
  try { fs.chmodSync(certDir + '/privkey.pem', 0o600); } catch (e) {}
  L('  v 证书已安装到 ' + certDir);
  return true;
}

async function verifyCert(L, domain) {
  const fp = '/etc/ssl/securev/' + domain + '/fullchain.pem';
  const r = await run('openssl', ['x509', '-in', fp, '-noout', '-subject', '-issuer', '-dates', '-ext', 'subjectAltName'], null, 20000);
  const out = (r.out || '') + (r.err || '');
  out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((s) => L('  ' + s));
  const ok = out.indexOf('DNS:' + domain) >= 0;
  if (!ok) L('  ! 证书里没有 DNS:' + domain + '，确认域名填对了没');
  return ok;
}

function saveCertCfg(domain) {
  CFG.acmeDomain = domain;
  CFG.certFile = '/etc/ssl/securev/' + domain + '/fullchain.pem';
  CFG.keyFile  = '/etc/ssl/securev/' + domain + '/privkey.pem';
  saveConfig(CFG);
}

function natUnit(cidr, iface) { return TPL.natUnit(cidr, iface, CFG.ocservService); }

async function doCert(p, L) {
  const mode = String(p.mode || '');
  const domain = String(p.domain || '').trim().toLowerCase();
  if (!validDomain(domain)) { L('x 域名不合法: ' + (domain || '(空)')); return false; }
  const certDir = '/etc/ssl/securev/' + domain;

  if (mode === 'upload') {
    const crt = String(p.cert || ''), key = String(p.key || '');
    if (crt.indexOf('BEGIN CERTIFICATE') < 0) { L('x 证书内容不像 PEM'); return false; }
    if (key.indexOf('PRIVATE KEY') < 0) { L('x 私钥内容不像 PEM'); return false; }
    writeAs(certDir + '/privkey.pem', key.replace(/\s*$/, '\n'), 0o600);
    writeAs(certDir + '/fullchain.pem', crt.replace(/\s*$/, '\n'), 0o644);
    const blocks = crt.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (blocks.length) writeAs(certDir + '/cert.pem', blocks[0] + '\n', 0o644);
    if (blocks.length > 1) writeAs(certDir + '/ca.pem', blocks.slice(1).join('\n') + '\n', 0o644);
    L('v 已写入 ' + certDir);
    saveCertCfg(domain);
    await verifyCert(L, domain);
    return true;
  }

  if (mode === 'selfsigned') {
    try { fs.mkdirSync(certDir, { recursive: true }); } catch (e) {}
    const r = await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-days', '30', '-subj', '/CN=' + domain, '-addext', 'subjectAltName=DNS:' + domain,
      '-keyout', certDir + '/privkey.pem', '-out', certDir + '/fullchain.pem'], null, 60000);
    if (r.code !== 0) { L('x 生成自签证书失败:\n' + tailOf(r)); return false; }
    try { fs.chmodSync(certDir + '/privkey.pem', 0o600); } catch (e) {}
    try { fs.copyFileSync(certDir + '/fullchain.pem', certDir + '/cert.pem'); fs.copyFileSync(certDir + '/fullchain.pem', certDir + '/ca.pem'); } catch (e) {}
    L('v 已生成自签证书（仅供联调，客户端会报证书不受信任）');
    saveCertCfg(domain);
    await verifyCert(L, domain);
    return true;
  }

  if (mode !== 'dns' && mode !== 'http') { L('x 未知的证书方式: ' + (mode || '(空)')); return false; }
  const email = String(p.email || '').trim();
  const env = {};
  let prov = '';
  let lines = [];
  // 先把用户输入校验干净，再去动网络/装东西（失败要快）
  if (mode === 'dns') {
    prov = String(p.provider || '').replace(/^dns_/, '');
    if (!/^[a-z0-9_]+$/.test(prov)) { L('x DNS 服务商标识不合法'); return false; }
    const creds = (p.creds && typeof p.creds === 'object') ? p.creds : {};
    for (const k of Object.keys(creds)) {
      const v = String(creds[k] == null ? '' : creds[k]).trim();
      if (!v || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      lines.push(k + '=' + v); env[k] = v;
    }
    if (Array.isArray(p.extra)) {
      for (const raw of p.extra) {
        const s = String(raw || '').trim();
        if (!s || s.charAt(0) === '#') continue;
        const i = s.indexOf('=');
        if (i <= 0) continue;
        const k = s.slice(0, i).trim(), v = s.slice(i + 1).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        lines.push(k + '=' + v); env[k] = v;
      }
    }
    if (!lines.length) { L('x 没有填 DNS API 凭据'); return false; }
  }

  if (!await ensureAcme(L, email)) return false;
  await setAcmeEmail(L, email);

  if (mode === 'dns') {
    if (!await ensureDnsapi('dns_' + prov, L)) return false;
    writeAs(DNS_ENV, '# 由面板「配置向导」写入；acme.sh 续期时自动加载\n' + lines.join('\n') + '\n', 0o600);
    L('v 凭据已写入 ' + DNS_ENV + ' (600)：' + Object.keys(env).join(' '));
    if (!await runIssue(L, { mode: 'dns', domain, provider: prov, dnssleep: p.dnssleep }, env)) return false;
  } else {
    L('HTTP-01：需要外部能访问本机 80 端口（acme.sh 会临时占用）');
    if (!await runIssue(L, { mode: 'http', domain }, env)) return false;
  }
  saveCertCfg(domain);
  await verifyCert(L, domain);
  return true;
}

async function doApply(p, L) {
  const domain = String(p.domain || CFG.acmeDomain || '').trim().toLowerCase();
  const vpnPort = String(parseInt(p.vpnPort, 10) || 443);
  const vpnNet = String(p.vpnNet || '').trim();
  const vpnMask = String(p.vpnMask || '255.255.255.0').trim();
  const dns1 = String(p.dns1 || '').trim() || '1.1.1.1';
  const dns2 = String(p.dns2 || '').trim() || '8.8.8.8';
  const outIf = String(p.outIf || '').trim() || await detectOutIf();

  if (!validDomain(domain)) { L('x 域名不合法'); return false; }
  if (!isIp(vpnNet)) { L('x VPN 网段不合法（形如 10.66.66.0）'); return false; }
  if (!isIp(vpnMask)) { L('x 掩码不合法'); return false; }
  if (!/^\d+$/.test(vpnPort) || +vpnPort < 1 || +vpnPort > 65535) { L('x 端口不合法'); return false; }
  if (!/^[A-Za-z0-9._:-]+$/.test(outIf)) { L('x 出口网卡名不合法'); return false; }
  if (!fileInfo('/etc/ssl/securev/' + domain + '/fullchain.pem')) { L('x 没找到 ' + domain + ' 的证书，请先完成「第 2 步 证书」'); return false; }

  const t = tpl('ocserv.conf.tpl');
  if (!t) { L('x 找不到模板 ' + path.join(TPL_DIR, 'ocserv.conf.tpl')); return false; }
  const conf = fillTpl(t, {
    CERTDIR: '/etc/ssl/securev/' + domain, VPNPORT: vpnPort, VPNNET: vpnNet, VPNMASK: vpnMask,
    DOMAIN: domain.split('.').slice(1).join('.'), DNS1: dns1, DNS2: dns2
  });
  if (fileInfo(CFG.ocservConf)) { try { fs.copyFileSync(CFG.ocservConf, CFG.ocservConf + '.bak-' + Date.now()); } catch (e) {} }
  writeAs(CFG.ocservConf, conf, 0o644);
  const tc = await run(CFG.ocservBin, ['-c', CFG.ocservConf, '--test-config'], null, 30000);
  if (tc.code !== 0) { L('x 配置校验失败:\n' + tailOf(tc, 10)); return false; }
  L('v 已写入 ' + CFG.ocservConf + ' 并通过 --test-config 校验');

  const users = Array.isArray(p.users) ? p.users : [];
  for (const u of users) {
    if (!u || !u.name) continue;
    const r = await addUser(String(u.name), String(u.password || ''));
    L(r.ok ? 'v 已创建 VPN 用户: ' + u.name : 'x 用户 ' + u.name + ' 创建失败: ' + r.error);
  }

  const cidr = vpnNet + '/' + maskBits(vpnMask);
  writeAs(NAT_UNIT, natUnit(cidr, outIf), 0o644);
  await run('systemctl', ['daemon-reload'], null, 30000);
  const nat = await run('systemctl', ['enable', '--now', 'ocserv-nat.service'], null, 30000);
  L(nat.code === 0 ? 'v NAT/转发单元已启用（' + cidr + ' 出口 ' + outIf + '）' : '! NAT 单元启用失败:\n' + tailOf(nat));

  const rt = tpl('acme-renew.sh.tpl');
  if (rt) {
    writeAs('/usr/local/bin/acme-renew.sh',
      fillTpl(rt, { DOMAIN: domain, OCSERV_SERVICE: CFG.ocservService, PANEL_SERVICE: PANEL_SVC }), 0o755);
    await run('bash', ['-c', "crontab -l 2>/dev/null | grep -v 'acme-renew.sh' > /tmp/.ct.new || true; echo '30 3 * * * /usr/local/bin/acme-renew.sh' >> /tmp/.ct.new; crontab /tmp/.ct.new"], null, 30000);
    L('v 已安装续期脚本 /usr/local/bin/acme-renew.sh + cron（每天 03:30）');
  } else {
    L('! 找不到 acme-renew.sh.tpl，跳过续期安装');
  }

  await run('systemctl', ['enable', CFG.ocservService], null, 30000);
  await run('systemctl', ['restart', CFG.ocservService], null, 30000);
  await new Promise((s) => setTimeout(s, 2000));
  const os1 = await ocservStatus();
  const listen = (os1.listen || []).map((x) => x.proto + ' ' + x.port).join(' · ') || '(无)';
  L((os1.active === 'active' ? 'v' : 'x') + ' ocserv 服务: ' + os1.active + '/' + os1.SubState);
  L('v 监听: ' + listen);
  if (os1.active !== 'active') L('  排查: journalctl -u ' + CFG.ocservService + ' -n 30');
  return os1.active === 'active';
}

async function runWizard(fn, body) {
  const arr = [];
  const L = (m) => { arr.push(String(m)); };
  let ok = false;
  try { ok = await fn(body || {}, L); }
  catch (e) { L('x 内部错误: ' + String((e && e.message) || e)); }
  let status = null;
  try { status = await setupStatus(); } catch (e) {}
  return { ok, log: arr.join('\n'), status };
}

/* ------------------------------------------------------------------ HTTP */

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}
function sendHtml(res, code, html) {
  const body = Buffer.from(html);
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

/* --------------------------------------------------- 面板自身设置(改密码/改端口) */

// 能否在 host:port 上监听（已被占用/无权限 -> false）
function portFree(port, host) {
  return new Promise((resolve) => {
    const t = net.createServer();
    t.once('error', () => resolve(false));
    t.once('listening', () => { t.close(() => resolve(true)); });
    try { t.listen({ port, host, exclusive: true }); } catch (e) { resolve(false); }
  });
}

// 改端口后不可能“原地”换监听端口，所以写盘 -> 回响应 -> 退出进程，靠 systemd 拉起。
// 没有 systemd 时（手动 node server.js）自己 detached 重启一个。
function scheduleRestart() {
  const underSystemd = !!process.env.INVOCATION_ID || !!process.env.JOURNAL_STREAM;
  setTimeout(() => {
    if (!underSystemd) {
      try {
        const c = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env });
        c.unref();
      } catch (e) { console.error('[panel] 自行重启失败: ' + ((e && e.message) || e)); }
    }
    process.exit(0);
  }, 800);
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const method = req.method.toUpperCase();

  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/' || p === '/index.html') {
    return sendHtml(res, 200, readText(path.join(PUBLIC_DIR, 'index.html'), '') || '<h1>public/index.html 缺失</h1>');
  }
  if (p === '/api/meta') return send(res, 200, { title: CFG.title, version: VERSION });
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  let body = null;
  if (method === 'POST') {
    // 防 CSRF: 自定义头 + 同源校验(浏览器跨站无法伪造自定义头而不触发预检)
    if (req.headers['x-panel'] !== '1') return send(res, 403, { error: '非法请求(缺少 x-panel 头)' });
    if (!sameOrigin(req)) return send(res, 403, { error: '非法来源' });
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return send(res, 400, { error: '请求体不是合法 JSON' }); }
  }

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const f = failures.get(ip);
    if (f && f.until > Date.now() && f.count >= MAX_FAILS) return send(res, 429, { error: '失败次数过多，请稍后再试' });
    const rec = CFG.users[body.username];
    if (!rec || !verifyPassword(String(body.password || ''), rec)) {
      const cur = failures.get(ip) || { count: 0, until: 0 };
      cur.count += 1; cur.until = Date.now() + FAIL_WINDOW;
      failures.set(ip, cur);
      return send(res, 401, { error: '用户名或密码错误' });
    }
    failures.delete(ip);
    const s = newSession(body.username);
    const secure = isTls ? '; Secure' : '';
    res.setHeader('Set-Cookie', 'sid=' + s.token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL / 1000) + secure);
    return send(res, 200, { ok: true, user: body.username, csrf: s.csrf });
  }

  const sess = getSession(req);
  if (!sess) return send(res, 401, { error: '未登录' });

  if (p === '/api/logout' && method === 'POST') {
    sessions.delete(parseCookies(req.headers.cookie).sid);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/me') return send(res, 200, { user: sess.user, csrf: sess.csrf });

  try {
    if (p === '/api/overview' && method === 'GET') {
      const [oc, cert, ss] = await Promise.all([ocservStatus(), certInfo(), getSessions()]);
      const users = readUsers();
      const cron = (await run('crontab', ['-l'])).out.split('\n').filter((l) => l.includes('acme')).join('\n');
      return send(res, 200, {
        ocserv: oc, cert,
        users: { count: users.length, names: users.map((x) => x.name) },
        sessions: { count: (ss.list || []).length },
        renew: { cron }, system: systemInfo(),
        meta: { title: CFG.title, ocservService: CFG.ocservService, acmeDomain: CFG.acmeDomain }
      });
    }
    if (p === '/api/users' && method === 'GET') return send(res, 200, { users: readUsers() });
    if (p === '/api/auth' && method === 'GET') return send(res, 200, authState());
    if (p === '/api/auth' && method === 'POST') {
      const r = await setAuthMethod(body);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/users' && method === 'POST') {
      let r = { ok: false, error: '未知操作' };
      if (body.action === 'add' || body.action === 'passwd') r = await addUser(body.username, String(body.password || ''));
      else if (body.action === 'del') r = await delUser(body.username);
      return send(res, r.ok ? 200 : 400, { ...r, users: readUsers() });
    }
    if (p === '/api/sessions' && method === 'GET') return send(res, 200, await getSessions());

    /* ---- 面板自身设置 ---- */
    if (p === '/api/panel' && method === 'GET') {
      return send(res, 200, {
        version: VERSION, title: CFG.title, host: CFG.host, port: CFG.port, https: !!CFG.https,
        users: Object.keys(CFG.users || {}), configFile: CONF_FILE
      });
    }
    if (p === '/api/panel/password' && method === 'POST') {
      const me = CFG.users[sess.user];
      const oldPw = String(body.oldPassword || '');
      if (!verifyPassword(oldPw, me)) return send(res, 400, { error: '当前密码不正确' });
      const newPw = String(body.newPassword || '');
      if (newPw.length < 6) return send(res, 400, { error: '新密码至少 6 位' });
      if (newPw === oldPw) return send(res, 400, { error: '新密码与当前密码相同' });
      CFG.users[sess.user] = hashPassword(newPw);
      saveConfig(CFG);
      writeCredFile(CFG, sess.user, newPw);
      return send(res, 200, { ok: true, user: sess.user });
    }
    if (p === '/api/panel/port' && method === 'POST') {
      const me = CFG.users[sess.user];
      if (!verifyPassword(String(body.password || ''), me)) return send(res, 400, { error: '当前密码不正确' });
      const port = parseInt(body.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: '端口必须是 1~65535 的整数' });
      if (port === CFG.port) return send(res, 400, { error: '新端口与当前端口相同' });
      // 先试能不能真的监听，不行就不写盘（避免把自己改到起不来的端口上）
      if (!(await portFree(port, CFG.host))) return send(res, 409, { error: '端口 ' + port + ' 无法监听（已被占用或权限不足），未做修改' });
      const old = CFG.port;
      CFG.port = port;
      saveConfig(CFG);
      console.log('[panel] 监听端口 ' + old + ' -> ' + port + '，正在重启');
      scheduleRestart();
      return send(res, 200, { ok: true, port, host: CFG.host, oldPort: old, https: !!CFG.https });
    }

    if (p === '/api/service' && method === 'POST') {
      if (!['start', 'stop', 'restart', 'reload'].includes(body.action)) return send(res, 400, { error: '不支持的操作' });
      const r = await run('systemctl', [body.action, CFG.ocservService], null, 30000);
      await new Promise((s) => setTimeout(s, 1500));
      const st = await ocservStatus();
      return send(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, out: (r.out + r.err).trim(), state: st.ActiveState, sub: st.SubState });
    }
    if (p === '/api/logs' && method === 'GET') {
      const n = Math.min(Math.max(parseInt(u.searchParams.get('lines') || '200', 10) || 200, 10), 2000);
      const r = await run('journalctl', ['-u', CFG.ocservService, '-n', String(n), '--no-pager', '-o', 'short-iso']);
      return send(res, 200, { lines: r.out || r.err });
    }
    if (p === '/api/config' && method === 'GET') {
      return send(res, 200, { content: readText(CFG.ocservConf, ''), path: CFG.ocservConf, info: fileInfo(CFG.ocservConf) });
    }
    if (p === '/api/config' && method === 'POST') {
      const content = String(body.content || '');
      if (!content.includes('server-cert') || !content.includes('tcp-port')) return send(res, 400, { error: '内容看起来不像 ocserv 配置，已拒绝写入' });
      const bak = CFG.ocservConf + '.bak-' + Date.now();
      fs.copyFileSync(CFG.ocservConf, bak);
      fs.writeFileSync(CFG.ocservConf, content, { mode: 0o644 });
      const t = await run(CFG.ocservBin, ['-c', CFG.ocservConf, '--test-config'], null, 20000);
      if (t.code !== 0) {
        fs.copyFileSync(bak, CFG.ocservConf);
        return send(res, 400, { error: '配置校验失败，已回滚\n' + (t.err || t.out).trim() });
      }
      const rl = await run('systemctl', ['reload-or-restart', CFG.ocservService], null, 30000);
      return send(res, 200, { ok: true, backup: bak, out: (rl.out + rl.err).trim() });
    }
    if (p === '/api/options' && method === 'GET') return send(res, 200, { options: readOptions() });
    if (p === '/api/options' && method === 'POST') {
      const r = await setOption(String(body.key || ''), !!body.value);
      return send(res, r.ok ? 200 : 400, { ...r, options: readOptions() });
    }

    /* ---- 首次配置向导 ---- */
    if (p === '/api/setup' && method === 'GET') return send(res, 200, await setupStatus());
    if (p === '/api/setup/cert' && method === 'POST') {
      const r = await runWizard(doCert, body);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/setup/apply' && method === 'POST') {
      const r = await runWizard(doApply, body);
      return send(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/cert' && method === 'GET') {
      return send(res, 200, { cert: await certInfo(), log: (readText(CFG.renewLog, '') || '').trim().split('\n').slice(-40).join('\n') });
    }
    if (p === '/api/renew' && method === 'POST') {
      const r = await renew(!!body.force);
      return send(res, r.ok ? 200 : 500, r);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
}

/* ------------------------------------------------------------- 启动 */

let isTls = false;
function tlsReady() { return fs.existsSync(CFG.certFile) && fs.existsSync(CFG.keyFile); }

function buildServer() {
  const onReq = (req, res) => handle(req, res).catch((e) => { try { send(res, 500, { error: String(e) }); } catch (x) {} });
  let srv;
  if (CFG.https && tlsReady()) {
    let cache = { mtime: 0, ctx: null };
    const secureContext = () => {
      const m = Math.max(fs.statSync(CFG.certFile).mtimeMs, fs.statSync(CFG.keyFile).mtimeMs);
      if (!cache.ctx || cache.mtime !== m) {
        cache = { mtime: m, ctx: tls.createSecureContext({ cert: fs.readFileSync(CFG.certFile), key: fs.readFileSync(CFG.keyFile) }) };
        console.log('[panel] 已加载证书 (mtime=' + new Date(m).toISOString() + ')');
      }
      return cache.ctx;
    };
    srv = https.createServer({
      cert: fs.readFileSync(CFG.certFile), key: fs.readFileSync(CFG.keyFile), minVersion: 'TLSv1.2',
      SNICallback: (name, cb) => { try { cb(null, secureContext()); } catch (e) { cb(e); } }
    }, onReq);
    isTls = true;
  } else {
    if (CFG.https) console.warn('[panel] 配置了 https=true 但证书文件不存在，降级为 HTTP');
    srv = http.createServer(onReq);
    isTls = false;
  }
  return srv;
}

const server = buildServer();
server.listen(CFG.port, CFG.host, () => {
  console.log('[panel] ' + CFG.title + ' v' + VERSION);
  console.log('[panel] ' + (isTls ? 'https' : 'http') + '://' + CFG.host + ':' + CFG.port + ' 已启动');
  console.log('[panel] ocserv 服务: ' + CFG.ocservService + ' | 配置: ' + CFG.ocservConf);
});

process.on('uncaughtException', (e) => console.error('[panel] uncaught: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => console.error('[panel] unhandled: ' + ((e && e.stack) || e)));
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
process.on('SIGINT', () => process.exit(0));
