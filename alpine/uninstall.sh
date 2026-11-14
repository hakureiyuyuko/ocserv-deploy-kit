#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#  Alpine 包卸载（默认保留配置、证书、面板账号；--purge 全清）
set -eu

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" = 0 ] || { echo "请用 root 运行" >&2; exit 1; }

for s in ocserv-panel ocserv ocserv-nat; do
  rc-service "$s" stop >/dev/null 2>&1 || true
  rc-update del "$s" default >/dev/null 2>&1 || true
done
rm -f /etc/init.d/ocserv /etc/init.d/ocserv-panel /etc/init.d/ocserv-nat
rm -f /usr/local/sbin/ocserv
rm -rf /opt/ocserv-deploy-kit /opt/ocserv-panel

if [ "$PURGE" = 1 ]; then
  rm -rf /etc/ocserv /etc/ssl/securev
  rm -f /var/log/ocserv.log /var/log/ocserv-panel.log /var/log/acme-renew.log
  echo "已清除配置与证书"
else
  echo "已移除程序；配置（/etc/ocserv）、证书（/etc/ssl/securev）保留。"
  echo "要一起清掉：$0 --purge"
fi
