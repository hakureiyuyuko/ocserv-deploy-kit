'use strict';
/*
 * 纯函数集合：模板渲染 / 网段换算 / systemd 单元生成
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * 这里不碰文件系统、不执行命令，所以可以脱离 Linux 单独测试。
 */

// 把 @KEY@ 占位符替换掉
function fillTpl(text, map) {
  let t = String(text);
  for (const k of Object.keys(map || {})) t = t.split('@' + k + '@').join(String(map[k]));
  return t;
}

// 找出还没被替换的占位符（自检用）
function missingPlaceholders(text) {
  const m = String(text).match(/@[A-Z0-9_]+@/g);
  return m ? Array.from(new Set(m)) : [];
}

// 掩码 -> 位宽 (255.255.255.0 -> 24)
function maskBits(mask) {
  let b = 0;
  for (const p of String(mask).split('.').map(Number)) {
    let n = p;
    while (n > 0) { b += n & 1; n >>= 1; }
  }
  return b;
}

// ocserv.conf：把向导收集的参数灌进模板
function renderConf(tplText, o) {
  const domain = String(o.domain || '');
  return fillTpl(tplText, {
    CERTDIR: '/etc/ssl/securev/' + domain,
    VPNPORT: o.vpnPort,
    VPNNET: o.vpnNet,
    VPNMASK: o.vpnMask,
    DOMAIN: domain.split('.').slice(1).join('.'),
    DNS1: o.dns1,
    DNS2: o.dns2
  });
}

// 续期脚本：替换域名与服务名
function renderRenew(tplText, o) {
  return fillTpl(tplText, {
    DOMAIN: o.domain,
    OCSERV_SERVICE: o.ocservService || 'ocserv',
    PANEL_SERVICE: o.panelService || 'ocserv-panel'
  });
}

// NAT/转发 systemd 单元（开机自动恢复 iptables 规则）
function natUnit(cidr, iface, ocservService) {
  const svc = ocservService || 'ocserv';
  const exec = 'sysctl -w net.ipv4.ip_forward=1; ' +
    'iptables -t nat -C POSTROUTING -s ' + cidr + ' -o ' + iface + ' -j MASQUERADE 2>/dev/null || ' +
    'iptables -t nat -A POSTROUTING -s ' + cidr + ' -o ' + iface + ' -j MASQUERADE; ' +
    'iptables -C FORWARD -s ' + cidr + ' -j ACCEPT 2>/dev/null || iptables -A FORWARD -s ' + cidr + ' -j ACCEPT; ' +
    'iptables -C FORWARD -d ' + cidr + ' -j ACCEPT 2>/dev/null || iptables -A FORWARD -d ' + cidr + ' -j ACCEPT';
  const stop = 'iptables -t nat -D POSTROUTING -s ' + cidr + ' -o ' + iface + ' -j MASQUERADE 2>/dev/null; ' +
    'iptables -D FORWARD -s ' + cidr + ' -j ACCEPT 2>/dev/null; ' +
    'iptables -D FORWARD -d ' + cidr + ' -j ACCEPT 2>/dev/null; true';
  return [
    '[Unit]',
    'Description=ocserv NAT/forwarding rules',
    'After=network-online.target',
    'Before=' + svc + '.service',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    "ExecStart=/bin/bash -c '" + exec + "'",
    "ExecStop=/bin/bash -c '" + stop + "'",
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    ''
  ].join('\n');
}

// NAT/转发 OpenRC 服务（Alpine）：开机自动恢复 iptables 规则
function natInitd(cidr, iface, ocservService) {
  const svc = ocservService || 'ocserv';
  return [
    '#!/sbin/openrc-run',
    'description="ocserv NAT / forwarding rules"',
    '',
    'CIDR="' + cidr + '"',
    'IFACE="' + iface + '"',
    '',
    'depend() {',
    '    need net',
    '    after firewall',
    '    before ' + svc + '',
    '}',
    '',
    'start() {',
    '    ebegin "Adding NAT rules for $CIDR via $IFACE"',
    '    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1',
    '    iptables -t nat -C POSTROUTING -s "$CIDR" -o "$IFACE" -j MASQUERADE 2>/dev/null || \\',
    '        iptables -t nat -A POSTROUTING -s "$CIDR" -o "$IFACE" -j MASQUERADE',
    '    iptables -C FORWARD -s "$CIDR" -j ACCEPT 2>/dev/null || iptables -A FORWARD -s "$CIDR" -j ACCEPT',
    '    iptables -C FORWARD -d "$CIDR" -j ACCEPT 2>/dev/null || iptables -A FORWARD -d "$CIDR" -j ACCEPT',
    '    eend $?',
    '}',
    '',
    'stop() {',
    '    ebegin "Removing NAT rules for $CIDR"',
    '    iptables -t nat -D POSTROUTING -s "$CIDR" -o "$IFACE" -j MASQUERADE 2>/dev/null',
    '    iptables -D FORWARD -s "$CIDR" -j ACCEPT 2>/dev/null',
    '    iptables -D FORWARD -d "$CIDR" -j ACCEPT 2>/dev/null',
    '    eend 0',
    '}',
    ''
  ].join('\n');
}

function validDomain(d) {
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(String(d || ''));
}
function isIp(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '')); }
function validUnixName(s) { return /^[A-Za-z0-9._@-]{1,32}$/.test(String(s || '')); }

// DNS 凭据形状自检：只做"能不能像该服务商凭据"的判断，不联网。
// 目的：拦住把 Account ID 填进 API Token 栏（顺序错位）这类错误，否则要到签发时才炸。
const CF_HEX32 = /^[0-9a-f]{32}$/i;
function ruleOut(creds, key) {
  const v = String((creds && creds[key]) || '').trim().replace(/^[\s"']+|[\s"']+$/g, '');
  return v;
}
function dnsCredsIssue(provider, creds) {
  if (String(provider || '') !== 'cf') return '';
  const tok = ruleOut(creds, 'CF_Token');
  const acc = ruleOut(creds, 'CF_Account_ID');
  const zid = ruleOut(creds, 'CF_Zone_ID');
  if (!tok) return 'Cloudflare 需要填 API Token（Account ID 可空，只填 Token 也能用）';
  if (CF_HEX32.test(tok)) {
    return '「API Token」填的是 32 位十六进制串（这是 Account ID / Zone ID 的形状）；API Token 是 cfat 开头、40 位以上的字符串，检查是否把两栏的值填反了';
  }
  if (acc && !CF_HEX32.test(acc)) {
    return '「Account ID」应为 32 位十六进制，当前 ' + acc.length + ' 位，看起来是 API Token —— 两栏多半填反了，请对调';
  }
  if (zid && !CF_HEX32.test(zid)) return '「Zone ID」应为 32 位十六进制，当前 ' + zid.length + ' 位';
  if (!/^[A-Za-z0-9_-]+$/.test(tok)) return '「API Token」含非法字符（可能粘进了空格、引号或列表里的省略号 …）';
  if (tok.length < 40) {
    return '「API Token」只有 ' + tok.length + ' 位，Cloudflare API Token 一般 40 位以上（Global API Key 是 37 位，本工具不支持，请新建 Zone → DNS → Edit 权限的 API Token）';
  }
  return '';
}

module.exports = { fillTpl, missingPlaceholders, maskBits, natUnit, natInitd, renderConf, renderRenew, validDomain, isIp, validUnixName, dnsCredsIssue };
