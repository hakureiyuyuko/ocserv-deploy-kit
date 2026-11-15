#!/bin/sh
# ============================================================
#  证书自动续期（Alpine / OpenRC 版，POSIX sh，**不依赖 bash**）
#  由面板「配置向导」按实际域名生成，占位符 @DOMAIN@ / @ACME_BIN@ / @ACME_HOME@ /
#  @OCSERV_SERVICE@ / @PANEL_SERVICE@ 已被替换。
#  由 busybox crond 的 /etc/periodic/daily 调用（也可以手动执行）
#  日志: /var/log/acme-renew.log
# ============================================================
DOMAIN=@DOMAIN@
CERTDIR=/etc/ssl/securev/$DOMAIN
ACME=@ACME_BIN@
ACME_HOME=@ACME_HOME@
DNS_ENV=/etc/ocserv/acme-dns.env
LOG=/var/log/acme-renew.log
OCSERV_SERVICE=@OCSERV_SERVICE@
PANEL_SERVICE=@PANEL_SERVICE@

exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 检查证书续期 ====="

enddate() { openssl x509 -in "$CERTDIR/fullchain.pem" -noout -enddate 2>/dev/null | cut -d= -f2; }
before="$(enddate)"

# DNS-01 的 API 凭据（cron 环境里没有这些变量）
if [ -f "$DNS_ENV" ]; then . "$DNS_ENV"; fi

if [ ! -x "$ACME" ]; then
  echo "!! 找不到 acme.sh：$ACME（Alpine 上可 apk add acme.sh）"
  exit 0
fi

"$ACME" --cron --home "$ACME_HOME"
echo "acme.sh --cron 退出码: $?"

after="$(enddate)"
if [ -n "$after" ] && [ "$before" != "$after" ]; then
  echo ">>> 证书已更新: $after"
  rc-service "$OCSERV_SERVICE" reload 2>/dev/null || rc-service "$OCSERV_SERVICE" restart
  echo "    ocserv -> $(rc-service "$OCSERV_SERVICE" status 2>&1 | tail -1)"
  rc-service "$PANEL_SERVICE" restart >/dev/null 2>&1
  echo "    面板已重启（加载新证书）"
else
  echo "证书未更新（未到期或失败），当前到期: ${after:-未知}"
fi

if [ -n "$after" ] && ! openssl x509 -in "$CERTDIR/fullchain.pem" -noout -checkend $((15 * 86400)) >/dev/null 2>&1; then
  echo "!! 警告：证书 15 天内到期，请检查续期是否正常"
fi
