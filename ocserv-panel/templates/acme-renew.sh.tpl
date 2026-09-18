#!/bin/bash
# ============================================================
#  证书自动续期脚本  (acme.sh + Let's Encrypt)
#  由面板「配置向导」按实际域名生成，占位符 @DOMAIN@ / @OCSERV_SERVICE@ /
#  @PANEL_SERVICE@ 已被替换。
#  cron : 30 3 * * * /usr/local/bin/acme-renew.sh
#  续期成功后: 热重载 ocserv(SIGHUP, 不断线) + 重启面板(加载新证书)
#  日志 : /var/log/acme-renew.log
# ============================================================
set -uo pipefail

# ---------------- 按需修改 ----------------
DOMAIN=@DOMAIN@                 # 证书域名
CERTDIR=/etc/ssl/securev/$DOMAIN
ACME=/root/.acme.sh/acme.sh
DNS_ENV=/etc/ocserv/acme-dns.env   # DNS-01 凭据(存在则加载)
LOG=/var/log/acme-renew.log
RELOAD_SERVICES="@OCSERV_SERVICE@"        # 续期后需要 reload 的服务(热重载证书,不断线)
RESTART_SERVICES="@PANEL_SERVICE@"        # 续期后需要 restart 的服务(重新读取证书文件)
# -----------------------------------------

exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 检查证书续期 ====="

enddate_of() { openssl x509 -in "$CERTDIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2; }
before="$(enddate_of)"

# DNS-01 需要 DNS 服务商 API 凭据, 而 cron 环境里没有这些变量 -> 从落盘文件加载
if [ -f "$DNS_ENV" ]; then . "$DNS_ENV"; fi

"$ACME" --cron --home /root/.acme.sh
echo "acme.sh --cron 退出码: $?"

after="$(enddate_of)"
echo "证书到期时间: ${before:-未知}"

if [ -n "$after" ] && [ "$before" != "$after" ]; then
  echo ">>> 证书已更新($after)"
  for s in $RELOAD_SERVICES; do
    systemctl reload "$s" 2>/dev/null || systemctl restart "$s"
    echo "    reload $s -> $(systemctl is-active "$s")"
  done
  for s in $RESTART_SERVICES; do
    systemctl try-restart "$s" 2>/dev/null
    sleep 1
    echo "    restart $s -> $(systemctl is-active "$s")"
  done
else
  echo "证书未到期，无需续期"
fi

if [ -n "$after" ]; then
  days=$(( ( $(date -d "$after" +%s) - $(date +%s) ) / 86400 ))
  echo "证书剩余 $days 天"
  [ "$days" -lt 15 ] && echo "!! 警告: 证书即将过期($days 天)，请检查续期是否正常"
fi
echo "===== 结束 ====="
