/* ============================================================================
 *  ocserv 管理面板 —— 在线演示用的 mock 接口层（纯前端，无后端）
 *
 *  作用：把真实面板发出的 /api/* 请求全部本地应答，数据都是虚构示例，
 *        点任何按钮都不会碰到服务器。错误路径（域名不合法、缺凭据、
 *        端口被占用、密码错误…）也照真实后端的行为还原。
 *
 *  这个文件由 tools/make-demo.mjs 内联进 docs/index.html，不单独上线。
 * ==========================================================================*/
(function () {
  'use strict';

  /* ------------------------------------------------------------ 演示数据 */
  var DOMAIN = 'vpn.example.com';
  var CERTDIR = '/etc/ssl/securev/' + DOMAIN;
  var CONF_PATH = '/etc/ocserv/ocserv.conf';
  var DAY = 86400000;
  var notAfter = new Date(Date.now() + 89 * DAY);

  var CONF_TPL = [
    '# ocserv 配置（由面板「配置向导」生成）',
    '',
    'auth = "plain[passwd=/etc/ocserv/ocpasswd]"',
    '',
    'tcp-port = @VPNPORT@',
    'udp-port = @VPNPORT@',
    '',
    'run-as-user = ocserv',
    'run-as-group = ocserv',
    'socket-file = /run/ocserv-socket',
    'pid-file = /run/ocserv.pid',
    '',
    'server-cert = @CERTDIR@/fullchain.pem',
    'server-key  = @CERTDIR@/privkey.pem',
    '',
    '# ---------------------------------------------------------------- 兼容性',
    'cisco-client-compat = true',
    'dtls-legacy = true',
    'try-mtu-discovery = true',
    'tls-priorities = "NORMAL:%SERVER_PRECEDENCE:%COMPAT:-VERS-SSL3.0:-VERS-TLS1.0:-VERS-TLS1.1"',
    '',
    '# ---------------------------------------------------------------- 运行参数',
    'isolate-workers = true',
    'max-clients = 32',
    'max-same-clients = 2',
    'keepalive = 32400',
    'dpd = 90',
    'mobile-dpd = 1800',
    'switch-to-tcp-timeout = 25',
    'auth-timeout = 240',
    'min-reauth-time = 300',
    'max-ban-score = 80',
    'ban-reset-time = 300',
    'cookie-timeout = 300',
    'deny-roaming = false',
    'rekey-time = 172800',
    'rekey-method = ssl',
    'use-occtl = true',
    'log-level = 1',
    'device = vpns',
    'predictable-ips = true',
    'default-domain = @DOMAIN@',
    '',
    '# ---------------------------------------------------------------- 客户端网络',
    'ipv4-network = @VPNNET@',
    'ipv4-netmask = @VPNMASK@',
    'mtu = 1420',
    '',
    'dns = @DNS1@',
    'dns = @DNS2@',
    'tunnel-all-dns = true',
    '',
    'route = default',
    'ping-leases = false',
    ''
  ].join('\n');

  function buildConf(o) {
    return CONF_TPL
      .split('@CERTDIR@').join(o.certDir === undefined ? CERTDIR : o.certDir)
      .split('@VPNPORT@').join(String(o.vpnPort || 443))
      .split('@VPNNET@').join(o.vpnNet || '10.66.66.0')
      .split('@VPNMASK@').join(o.vpnMask || '255.255.255.0')
      .split('@DOMAIN@').join(o.domain ? String(o.domain).split('.').slice(1).join('.') : 'example.com')
      .split('@DNS1@').join(o.dns1 || '1.1.1.1')
      .split('@DNS2@').join(o.dns2 || '8.8.8.8');
  }

  var OPTION_KEYS = {
    'cisco-client-compat': { label: 'AnyConnect 兼容模式', def: false, desc: '开启后 Cisco AnyConnect / 兼容客户端（含 OpenConnect 的 anyconnect 协议）可正常连接；关闭则只按标准 OpenConnect 协议协商。' },
    'dtls-legacy': { label: '兼容旧版 DTLS', def: true, desc: '老客户端无法协商 DTLS1.2 时回落到旧版本，兼容性更好。' },
    'try-mtu-discovery': { label: 'MTU 自动发现', def: true, desc: '自动探测可用 MTU，避免大包不通（建议保持开启）。' },
    'tunnel-all-dns': { label: 'DNS 全部走隧道', def: true, desc: '客户端把全部 DNS 解析都发给 VPN 下发的服务器。' },
    'deny-roaming': { label: '禁止漫游', def: false, desc: '客户端 IP 变化（切换网络）立即断开，更严格。' },
    'ping-leases': { label: '下发地址前 ping 探测', def: false, desc: '分配 IP 前先探测是否占用，避免地址冲突（大网络才需要）。' }
  };

  var PROVIDERS = [
    { id: 'cf', name: 'Cloudflare', fields: [{ k: 'CF_Token', label: 'API Token' }, { k: 'CF_Account_ID', label: 'Account ID(可空)' }] },
    { id: 'ali', name: '阿里云 DNS', fields: [{ k: 'Ali_Key', label: 'AccessKey ID' }, { k: 'Ali_Secret', label: 'AccessKey Secret' }] },
    { id: 'dp', name: 'DNSPod / 腾讯云', fields: [{ k: 'DP_Id', label: 'ID' }, { k: 'DP_Key', label: 'Token' }] },
    { id: 'gd', name: 'GoDaddy', fields: [{ k: 'GD_Key', label: 'Key' }, { k: 'GD_Secret', label: 'Secret' }] },
    { id: 'dgon', name: 'DigitalOcean', fields: [{ k: 'DO_API_KEY', label: 'API Token' }] }
  ];

  /* ocserv.conf 里的开关：像真后端一样"改文本"，所以「配置」页能看到效果 */
  function readOptions() {
    return Object.keys(OPTION_KEYS).map(function (key) {
      var meta = OPTION_KEYS[key];
      var m = state.conf.match(new RegExp('^[ \\t]*#?[ \\t]*' + key.replace(/-/g, '\\-') + '[ \\t]*=[ \\t]*(\\S+)', 'm'));
      return {
        key: key, label: meta.label, desc: meta.desc,
        value: m ? /^(true|yes|1)$/i.test(m[1]) : meta.def,
        present: !!m, isDefault: !m
      };
    });
  }
  function setOption(key, value) {
    if (!OPTION_KEYS[key]) return { ok: false, error: '不支持的选项: ' + key };
    var re = new RegExp('^[ \\t]*#?[ \\t]*' + key.replace(/-/g, '\\-') + '[ \\t]*=[^\\n]*$', 'm');
    var newLine = key + ' = ' + (value ? 'true' : 'false');
    var updated = re.test(state.conf) ? state.conf.replace(re, newLine) : state.conf.replace(/[\s]*$/, '') + '\n' + newLine + '\n';
    if (updated === state.conf) return { ok: true, changed: false, options: readOptions() };
    state.conf = updated;
    state.svc.active = true; state.svc.sub = 'running';
    return { ok: true, changed: true, backup: CONF_PATH + '.bak-' + Date.now(), out: '（演示：未真的 reload systemctl）', options: readOptions() };
  }
  /* ocserv 不允许两个密码类认证并存：切换=替换那一行 */
  var PW_METHODS = ['plain', 'pam', 'radius', 'gssapi', 'oidc'];
  function parseAuthLineDemo(line) {
    var m = String(line).match(/^\s*auth\s*=\s*"([^"]*)"/);
    if (!m) return null;
    var raw = m[1], br = raw.indexOf('[');
    var name = (br >= 0 ? raw.slice(0, br) : raw).trim().toLowerCase();
    var kv = {};
    if (br >= 0) raw.slice(br + 1).replace(/\]\s*$/, '').split(',').forEach(function (p) {
      var i = p.indexOf('='); if (i > 0) kv[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return { name: name, kv: kv, raw: raw };
  }
  function authStateDemo() {
    var list = state.conf.split('\n').map(parseAuthLineDemo).filter(Boolean);
    var pw = list.filter(function (a) { return PW_METHODS.indexOf(a.name) >= 0; });
    var cur = pw[0] || list[0] || null;
    return {
      method: cur ? cur.name : null, raw: cur ? cur.raw : null,
      others: list.filter(function (a) { return a !== cur; }).map(function (a) { return a.name; }),
      pam: cur && cur.name === 'pam' ? { service: cur.kv.service || '', gidMin: cur.kv['gid-min'] || '' } : null,
      methods: list.map(function (a) { return a.name; })
    };
  }
  function setAuthDemo(body) {
    var m = String(body.method || '');
    if (m !== 'plain' && m !== 'pam') return { ok: false, error: '不支持的认证方式: ' + m };
    var svc = String(body.service || '').trim(), gid = String(body.gidMin || '').trim();
    if (m === 'pam') {
      if (svc && !/^[A-Za-z0-9._@-]{1,64}$/.test(svc)) return { ok: false, error: 'PAM 服务名不合法（只允许字母/数字/._@-，最长 64）' };
      if (gid && !/^\d{1,9}$/.test(gid)) return { ok: false, error: 'gid-min 必须是数字' };
    }
    var parts = [];
    if (svc) parts.push('service=' + svc);
    if (gid) parts.push('gid-min=' + gid);
    var nl = m === 'plain' ? 'auth = "plain[passwd=/etc/ocserv/ocpasswd]"'
      : 'auth = "pam' + (parts.length ? '[' + parts.join(',') + ']' : '') + '"';
    if (m === 'pam' && svc === 'broken') return { ok: false, error: '配置校验失败，已回滚：（演示：拿 broken 演示回滚分支）' };
    var out = [], done = false;
    state.conf.split('\n').forEach(function (l) {
      var a = parseAuthLineDemo(l);
      if (a && PW_METHODS.indexOf(a.name) >= 0) { if (!done) { out.push(nl); done = true; } return; }
      out.push(l);
    });
    state.conf = out.join('\n');
    return { ok: true, changed: true, backup: CONF_PATH + '.bak-' + Date.now(), auth: authStateDemo(), out: '（演示：未真的 reload systemctl）' };
  }

  function parseListen() {    var out = [];
    state.conf.split('\n').forEach(function (l) {
      var m = l.match(/^\s*(tcp-port|udp-port)\s*=\s*(\d+)/);
      if (m) out.push({ proto: m[1].split('-')[0].toUpperCase(), port: Number(m[2]) });
    });
    return out;
  }
  function maskBits(mask) {
    var b = 0;
    String(mask).split('.').map(Number).forEach(function (p) { var n = p; while (n > 0) { b += n & 1; n >>= 1; } });
    return b;
  }
  var validDomain = function (d) { return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(String(d || '')); };
  var isIp = function (s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '')); };
  var validName = function (n) { return typeof n === 'string' && /^[A-Za-z0-9._@-]{1,32}$/.test(n); };

  function fmtTime(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  var LOGS = (function () {
    var t = Date.now() - 6 * 60000;
    var lines = [
      'systemd[1]: Started ocserv - OpenConnect VPN server.',
      'ocserv[812]: note: setting \'plain[passwd=/etc/ocserv/ocpasswd]\' as authentication method',
      'ocserv[812]: listening on TCP 0.0.0.0:443',
      'ocserv[812]: listening on UDP 0.0.0.0:443',
      'ocserv[812]: initialized with 1.2.4',
      'ocserv[812]: TLS is using the certificate of ' + DOMAIN,
      'ocserv[1418]: accepted connection from 203.0.113.24:51922',
      'ocserv[1418]: user \'alice\' authenticated (cookie issued)',
      'ocserv[1418]: assigned IPv4 address 10.66.66.3',
      'ocserv[1418]: DTLS handshake completed (cipher: AES-256-GCM)',
      'ocserv[1502]: accepted connection from 198.51.100.77:40118',
      'ocserv[1502]: user \'bob\' authenticated (cookie issued)',
      'ocserv[1502]: assigned IPv4 address 10.66.66.4',
      'ocserv[1502]: client requested reconnect, keeping session',
      'ocserv[1418]: received BYE from 203.0.113.24',
      'ocserv[1418]: user \'alice\' connection closed (0 packets lost)'
    ];
    return lines.map(function (l, i) {
      var d = new Date(t + i * 22000);
      return '2026-' + fmtTime(d) + ' demo-panel ocserv[812]: ' + l;
    }).join('\n');
  })();

  var RENEW_LOG = [
    '===== 2026-09-17 03:30:01 检查证书续期 =====',
    '[Wed Sep 17 03:30:01 CST 2026] Running cmd: --cron --home /root/.acme.sh',
    '[Wed Sep 17 03:30:03 CST 2026] Skipping. Next renewal time is: 2026-11-15T19:30:02Z',
    'acme.sh --cron 退出码: 2',
    '证书到期时间: Dec 17 12:03:00 2026 GMT',
    '证书未到期，无需续期',
    '证书剩余 90 天',
    '===== 结束 ====='
  ].join('\n');

  /* --------------------------------------------------------------- 状态 */
  var state = {
    loggedIn: true,                 // 演示：打开即已登录，可直接体验面板
    panelUser: 'admin',
    panelPw: 'admin',               // 演示口令（可故意输错看拦截）
    panelPort: 19999,
    title: 'ocserv 管理面板（在线演示）',
    version: '1.6.1-demo',
    svc: { active: true, sub: 'running', pid: '812', restarts: 0 },
    conf: buildConf({ vpnPort: 443, certDir: CERTDIR, domain: DOMAIN }),
    hasConf: true, hasNAT: true, acmeInstalled: true, outIf: 'eth0',
    users: [{ name: 'alice' }, { name: 'bob' }, { name: 'carol' }],
    // 按 occtl -j show users 的真实字段名造数据（前端按别名映射成固定列）
    sessions: [
      { ID: 38274, Username: 'alice', Groupname: '(none)', State: 'connected', vhost: 'default', Device: 'vpns0', MTU: 1354, 'Remote IP': '203.0.113.24', 'User-Agent': 'AnyConnect Windows 4.10', since: '2026-09-25 20:41' },
      { ID: 38281, Username: 'bob', Groupname: '(none)', State: 'connected', vhost: 'default', Device: 'vpns0', MTU: 1400, 'Remote IP': '198.51.100.77', 'User-Agent': 'OpenConnect v9.12', since: '2026-09-25 21:02' }
    ],
    certOk: true
  };

  function certObj() {
    return {
      exists: state.certOk,
      subject: 'CN=' + DOMAIN,
      issuer: "C=US, O=Let's Encrypt, CN=YE2",
      notBefore: 'Sep 18 12:03:00 2026 GMT',
      notAfter: notAfter.toUTCString().replace(/^\w+, /, '').replace(' GMT', ' GMT'),
      san: [DOMAIN, 'vpn4.example.com'],
      daysLeft: Math.floor((notAfter.getTime() - Date.now()) / DAY),
      nextRenew: (function () { var d = new Date(notAfter.getTime() - 30 * DAY); return d.toISOString().replace(/\.\d+Z$/, 'Z'); })(),
      reloadCmd: true,
      files: [
        { path: CERTDIR + '/fullchain.pem', size: 3846, mtime: new Date().toISOString() },
        { path: CERTDIR + '/privkey.pem', size: 227, mtime: new Date().toISOString() },
        { path: CERTDIR + '/ca.pem', size: 1310, mtime: new Date().toISOString() }
      ]
    };
  }
  function overview() {
    return {
      ocserv: {
        ActiveState: state.svc.active ? 'active' : 'inactive',
        SubState: state.svc.active ? state.svc.sub : 'dead',
        MainPID: state.svc.active ? state.svc.pid : '-',
        version: 'ocserv 1.2.4',
        listen: parseListen()
      },
      cert: { exists: true, daysLeft: certObj().daysLeft, subject: 'CN=' + DOMAIN, notAfter: certObj().notAfter },
      users: { count: state.users.length, names: state.users.map(function (u) { return u.name; }) },
      sessions: { count: state.sessions.length },
      renew: { cron: '30 3 * * * /usr/local/bin/acme-renew.sh' },
      system: { hostname: 'demo-vpn', platform: 'linux 6.8.0-generic', uptime: 4 * DAY / 1000 + 7320, loadavg: [0.08, 0.03, 0.01], mem: { percent: 18 }, nodeVersion: 'v18.19.1' },
      meta: { title: state.title, ocservService: 'ocserv', acmeDomain: DOMAIN }
    };
  }
  function setupStatus() {
    return {
      initialized: state.hasConf && state.certOk,
      hasConf: state.hasConf,
      certExists: state.certOk,
      cert: certObj(),
      service: { active: state.svc.active ? 'active' : 'inactive', sub: state.svc.sub, enabled: 'enabled', version: 'ocserv 1.2.4' },
      hasNAT: state.hasNAT,
      acmeInstalled: state.acmeInstalled,
      panel: { port: state.panelPort, host: '0.0.0.0', service: 'ocserv-panel' },
      outIf: state.outIf,
      templates: { ok: true, dir: '/opt/ocserv-panel/templates' },
      providers: PROVIDERS,
      presets: { vpnPort: 443, vpnNet: '10.66.66.0', vpnMask: '255.255.255.0', dns1: '1.1.1.1', dns2: '8.8.8.8', dnssleep: 30 }
    };
  }

  /* ------------------------------------------------------ 向导：签发证书 */
  function doCert(p, L) {
    var mode = String(p.mode || 'dns');
    var domain = String(p.domain || '').trim().toLowerCase();
    if (!validDomain(domain)) { L('x 域名不合法: ' + (domain || '(空)')); return false; }
    if (mode === 'upload') {
      if (String(p.cert || '').indexOf('BEGIN CERTIFICATE') < 0) { L('x 证书内容不像 PEM（要贴 -----BEGIN CERTIFICATE----- 开头的那段）'); return false; }
      if (String(p.key || '').indexOf('PRIVATE KEY') < 0) { L('x 私钥内容不像 PEM'); return false; }
      L('v 已写入 ' + '/etc/ssl/securev/' + domain + '/{fullchain,privkey}.pem（权限 600）');
    } else if (mode === 'selfsigned') {
      L('生成自签证书（仅测试用，客户端会报不受信任）…');
      L('v 已写入 /etc/ssl/securev/' + domain + '/{fullchain,privkey}.pem');
    } else if (mode === 'http') {
      L('HTTP-01：需要外部能访问本机 80 端口（acme.sh 会临时占用）');
      L('[acme] 请确认已解析 ' + domain + ' -> 本机公网 IP');
      L('v 证书已签发并安装');
    } else {
      var provider = String(p.provider || '');
      var creds = p.creds || {};
      var need = {};
      (PROVIDERS.filter(function (x) { return x.id === provider; })[0] || { fields: [] }).fields.forEach(function (f) { need[f.k] = f; });
      var missing = Object.keys(need).filter(function (k) {
        var label = String((need[k] && need[k].label) || '');
        return label.indexOf('可空') < 0 && !String(creds[k] || '').trim();
      });
      if (!Object.keys(creds).length || missing.length) {
        L('x 没有填 DNS API 凭据（' + (missing.length ? '缺 ' + missing.join(', ') : '至少要填一个') + '）');
        return false;
      }
      L('DNS-01：使用 dns_' + provider + ' 插件，等待 DNS 生效 ' + (p.dnssleep || 30) + 's…');
      L('  ' + Object.keys(creds).map(function (k) { return k + '=' + String(creds[k]).replace(/./g, '*'); }).join(' '));
      L('[acme] 申请 ' + domain + ' 的证书 (EC P-256)…');
      L('[acme] 签发成功，装到 /etc/ssl/securev/' + domain + '/{fullchain,privkey}.pem（privkey 600）');
      L('[acme] 续期后重载: systemctl reload ocserv');
    }
    L('--- openssl x509 -in /etc/ssl/securev/' + domain + '/fullchain.pem ---');
    L('subject=CN=' + domain);
    L("issuer=C = US, O = Let's Encrypt, CN = YE2");
    L('notBefore=Sep 18 12:03:00 2026 GMT');
    L('notAfter=Dec 17 12:03:00 2026 GMT');
    L('X509v3 Subject Alternative Name: DNS:' + domain);
    state.certOk = true;
    return true;
  }

  /* -------------------------------------------------------- 向导：应用配置 */
  function doApply(p, L) {
    var domain = String(p.domain || DOMAIN).trim().toLowerCase();
    var vpnPort = String(parseInt(p.vpnPort, 10) || 443);
    var vpnNet = String(p.vpnNet || '').trim();
    var vpnMask = String(p.vpnMask || '255.255.255.0').trim();
    var dns1 = String(p.dns1 || '').trim() || '1.1.1.1';
    var dns2 = String(p.dns2 || '').trim() || '8.8.8.8';
    var outIf = String(p.outIf || '').trim() || state.outIf;

    if (!validDomain(domain)) { L('x 域名不合法'); return false; }
    if (!isIp(vpnNet)) { L('x VPN 网段不合法（形如 10.66.66.0）'); return false; }
    if (!isIp(vpnMask)) { L('x 掩码不合法'); return false; }
    if (!/^\d+$/.test(vpnPort) || +vpnPort < 1 || +vpnPort > 65535) { L('x 端口不合法'); return false; }
    if (!/^[A-Za-z0-9._:-]+$/.test(outIf)) { L('x 出口网卡名不合法'); return false; }
    if (!state.certOk) { L('x 没找到 ' + domain + ' 的证书，请先完成「第 2 步 证书」'); return false; }

    var conf = buildConf({ vpnPort: vpnPort, certDir: '/etc/ssl/securev/' + domain, domain: domain, vpnNet: vpnNet, vpnMask: vpnMask, dns1: dns1, dns2: dns2 });
    L('v 已写入 ' + CONF_PATH + '（旧配置已备份为 ' + CONF_PATH + '.bak-' + Date.now() + '）并通过 --test-config 校验');
    state.conf = conf;
    state.hasConf = true;
    state.outIf = outIf;

    var users = Array.isArray(p.users) ? p.users : [];
    users.forEach(function (u) {
      if (!u || !u.name) return;
      if (!validName(u.name)) { L('x 用户 ' + u.name + ' 创建失败: 用户名只允许字母/数字/._@- ，最长 32 位'); return; }
      if (String(u.password || '').length < 6) { L('x 用户 ' + u.name + ' 创建失败: 密码至少 6 位'); return; }
      if (!state.users.some(function (x) { return x.name === u.name; })) state.users.push({ name: u.name });
      L('v 已创建 VPN 用户: ' + u.name);
    });

    var cidr = vpnNet + '/' + maskBits(vpnMask);
    L('v NAT/转发单元已启用（iptables -t nat -A POSTROUTING -s ' + cidr + ' -o ' + outIf + ' -j MASQUERADE）');
    state.hasNAT = true;
    L('v 已安装续期脚本 /usr/local/bin/acme-renew.sh + cron（每天 03:30）');
    state.svc.active = true; state.svc.sub = 'running';
    L('v ocserv 服务: active/running');
    L('v 监听: TCP ' + vpnPort + ' · UDP ' + vpnPort);
    return true;
  }

  /* ------------------------------------------------------------ 路由层 */
  function res(status, obj) {
    return {
      ok: status >= 200 && status < 300, status: status,
      json: function () { return Promise.resolve(obj); },
      text: function () { return Promise.resolve(JSON.stringify(obj)); },
      headers: { get: function () { return null; }, getSetCookie: function () { return []; } }
    };
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function handle(p, method, body, q) {
    var need401 = function (path) { return !state.loggedIn && path !== '/api/meta' && path !== '/api/login'; };

    if (p === '/api/meta') return res(200, { title: state.title, version: state.version });

    if (p === '/api/login' && method === 'POST') {
      if (!String(body.username || '').trim() || !String(body.password || '')) return res(401, { error: '用户名或密码错误' });
      if (String(body.username).trim() !== state.panelUser || String(body.password) !== state.panelPw) {
        return res(401, { error: '用户名或密码错误（演示口令：admin / admin）' });
      }
      state.loggedIn = true;
      return res(200, { ok: true, user: state.panelUser, csrf: 'demo' });
    }
    if (need401(p)) return res(401, { error: '未登录' });
    if (p === '/api/logout' && method === 'POST') { state.loggedIn = false; return res(200, { ok: true }); }
    if (p === '/api/me') return res(200, { user: state.panelUser, csrf: 'demo' });

    if (p === '/api/overview') return res(200, overview());
    if (p === '/api/users' && method === 'GET') {
      return res(200, { users: state.users.map(function (u) { return { name: u.name, group: '', hasHash: true }; }) });
    }
    if (p === '/api/users' && method === 'POST') {
      var name = String(body.username || '').trim();
      if (body.action === 'del') {
        if (!validName(name)) return res(400, { error: '非法用户名' });
        state.users = state.users.filter(function (u) { return u.name !== name; });
        state.sessions = state.sessions.filter(function (s) { return s.user !== name; });
        return res(200, { ok: true, users: state.users });
      }
      if (!validName(name)) return res(400, { error: '用户名只允许字母/数字/._@- ，最长 32 位' });
      if (String(body.password || '').length < 6) return res(400, { error: '密码至少 6 位' });
      if (body.action === 'add' && state.users.some(function (u) { return u.name === name; })) {
        return res(400, { error: '用户已存在（演示环境）' });
      }
      if (!state.users.some(function (u) { return u.name === name; })) state.users.push({ name: name });
      return res(200, { ok: true, users: state.users });
    }
    if (p === '/api/auth') {
      if (method === 'POST') {
        var ra = setAuthDemo(body);
        return res(ra.ok ? 200 : 400, ra);
      }
      return res(200, authStateDemo());
    }
    if (p === '/api/sessions') return res(200, { json: true, list: state.sessions });

    if (p === '/api/service' && method === 'POST') {
      var a = String(body.action || '');
      if (['start', 'restart', 'reload'].indexOf(a) < 0 && a !== 'stop') return res(400, { error: '不支持的操作' });
      if (a === 'stop') { state.svc.active = false; state.svc.sub = 'dead'; state.sessions = []; }
      else { state.svc.active = true; state.svc.sub = 'running'; state.svc.restarts += (a === 'restart' ? 1 : 0); }
      return res(200, { ok: true, out: '（演示环境：未执行真实 systemctl 命令）', state: state.svc.active ? 'active' : 'inactive', sub: state.svc.sub });
    }
    if (p === '/api/logs') {
      var n = parseInt(q.get('lines') || '200', 10) || 200;
      var lines = LOGS.split('\n');
      return res(200, { lines: lines.slice(-Math.min(n, lines.length)).join('\n') });
    }
    if (p === '/api/config' && method === 'GET') {
      return res(200, { content: state.conf, path: CONF_PATH, info: { path: CONF_PATH, size: state.conf.length, mtime: new Date().toISOString() } });
    }
    if (p === '/api/config' && method === 'POST') {
      var content = String(body.content || '');
      if (content.indexOf('server-cert') < 0 || content.indexOf('tcp-port') < 0) {
        return res(400, { error: '内容看起来不像 ocserv 配置，已拒绝写入' + '\n（演示环境同样会做这项校验：必须含 server-cert 与 tcp-port）' });
      }
      state.conf = content;
      return res(200, { ok: true, backup: CONF_PATH + '.bak-' + Date.now(), out: '（演示：未真的 reload systemctl）' });
    }
    if (p === '/api/options' && method === 'GET') return res(200, { options: readOptions() });
    if (p === '/api/options' && method === 'POST') {
      var r0 = setOption(String(body.key || ''), !!body.value);
      return res(r0.ok ? 200 : 400, r0);
    }

    if (p === '/api/setup') return res(200, setupStatus());
    if (p === '/api/setup/cert' && method === 'POST') {
      var log = []; var okc = false;
      try { okc = doCert(body, function (m) { log.push(String(m)); }); }
      catch (e) { log.push('x 内部错误: ' + (e && e.message || e)); }
      return res(okc ? 200 : 400, { ok: okc, log: log.join('\n'), status: setupStatus() });
    }
    if (p === '/api/setup/apply' && method === 'POST') {
      var log2 = []; var oka = false;
      try { oka = doApply(body, function (m) { log2.push(String(m)); }); }
      catch (e) { log2.push('x 内部错误: ' + (e && e.message || e)); }
      return res(oka ? 200 : 400, { ok: oka, log: log2.join('\n'), status: setupStatus() });
    }
    if (p === '/api/cert') return res(200, { cert: certObj(), log: RENEW_LOG });
    if (p === '/api/renew' && method === 'POST') {
      if (body.force) {
        return res(200, { ok: true, out: ['[演示] acme.sh --renew --force -d ' + DOMAIN + ' --server https://acme-v02.api.letsencrypt.org/directory',
          '  Skipping: 演示环境不会真的联系 Let\'s Encrypt',
          '  v 假设成功：证书已更新，systemctl reload ocserv'].join('\n') });
      }
      return res(200, { ok: true, out: RENEW_LOG });
    }

    /* ---- 面板自身设置 ---- */
    if (p === '/api/panel') {
      return res(200, {
        version: state.version, title: state.title, host: '0.0.0.0', port: state.panelPort, https: false,
        users: [state.panelUser], configFile: '/opt/ocserv-panel/config.json'
      });
    }
    if (p === '/api/panel/password' && method === 'POST') {
      if (String(body.oldPassword || '') !== state.panelPw) return res(400, { error: '当前密码不正确（演示口令 admin）' });
      var np = String(body.newPassword || '');
      if (np.length < 6) return res(400, { error: '新密码至少 6 位' });
      if (np === String(body.oldPassword || '')) return res(400, { error: '新密码与当前密码相同' });
      state.panelPw = np;
      return res(200, { ok: true, user: state.panelUser });
    }
    if (p === '/api/panel/port' && method === 'POST') {
      if (String(body.password || '') !== state.panelPw) return res(400, { error: '当前密码不正确（演示口令 admin）' });
      var port = parseInt(body.port, 10);
      if (!(port >= 1 && port <= 65535)) return res(400, { error: '端口必须是 1~65535 的整数' });
      if (port === state.panelPort) return res(400, { error: '新端口与当前端口相同' });
      if ([22, 25, 80, 443].indexOf(port) >= 0) return res(409, { error: '端口 ' + port + ' 无法监听（已被占用或权限不足），未做修改' });
      var old = state.panelPort;
      state.panelPort = port;
      /* 真实环境这里会自动重启并换端口；演示里只是改个数字，随后补一句说明 */
      setTimeout(function () {
        var el = document.getElementById('pnMsg');
        if (el) el.innerHTML += '<br><b>演示环境：面板并没有真的重启，刷新页面即恢复默认 19999。</b>';
      }, 400);
      return res(200, { ok: true, port: port, host: '0.0.0.0', oldPort: old, https: false });
    }

    return res(404, { error: 'not found: ' + p });
  }

  window.fetch = function (url, init) {
    var s = String(url && url.url ? url.url : url);
    var q = new URLSearchParams(s.indexOf('?') >= 0 ? s.slice(s.indexOf('?') + 1) : '');
    var p = s.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    var method = String((init && init.method) || 'GET').toUpperCase();
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
    return sleep(80 + Math.random() * 200).then(function () {
      try { return handle(p, method, body, q); }
      catch (e) { return res(500, { error: '演示 mock 出错: ' + (e && e.message || e) }); }
    });
  };

  /* ------------------------------------------------- 演示横条 / 登录预填 */
  function wire() {
    var lu = document.getElementById('lu'), lp = document.getElementById('lp');
    if (lu) lu.value = 'admin';
    if (lp) lp.value = 'admin';
    var btn = document.getElementById('demoReset');
    if (btn) btn.onclick = function () { location.reload(); };
    var ver = document.getElementById('demoVer');
    if (ver) ver.textContent = state.version;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
