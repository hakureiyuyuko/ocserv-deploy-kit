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

function validDomain(d) {
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(String(d || ''));
}
function isIp(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '')); }
function validUnixName(s) { return /^[A-Za-z0-9._@-]{1,32}$/.test(String(s || '')); }

module.exports = { fillTpl, missingPlaceholders, maskBits, natUnit, renderConf, renderRenew, validDomain, isIp, validUnixName };
