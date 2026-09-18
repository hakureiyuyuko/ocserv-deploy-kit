#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================
#  ACME 证书申请脚本  (acme.sh + Let's Encrypt, HTTP-01/80 端口)
#  用法:  acme-issue.sh <主域名> [备用域名...]
#  可选环境变量:
#    ACME_SERVER=https://acme-v02.api.letsencrypt.org/directory
#    KEYLEN=ec-256|2048|4096        密钥类型 (默认 ec-256)
#    INSECURE=1                     CA 自身 HTTPS 证书不被信任时打开
#    EAB_KID=xxx EAB_HMAC_KEY=yyy   若 CA 要求外部账户绑定
#    WEBROOT=/var/www/html          改用 webroot 模式(已有 Web 服务器时)
#    ACME_DNS=cf  DNS_SLEEP=30       改用 DNS-01 验证(值为 acme.sh 的 dnsapi 插件名,
#                                    凭据走环境变量, 如 CF_Token / CF_Account_ID)
#    RELOADCMD='systemctl reload nginx'   证书更新后执行的命令
#  证书输出: /etc/ssl/securev/<主域名>/{privkey,fullchain,cert,ca}.pem
# ============================================================
set -uo pipefail

ACME_BIN="${ACME_BIN:-/root/.acme.sh/acme.sh}"
ACME_SERVER="${ACME_SERVER:-https://acme-v02.api.letsencrypt.org/directory}"
KEYLEN="${KEYLEN:-ec-256}"
CERTDIR="${CERTDIR:-/etc/ssl/securev}"
LOG="${LOG:-/var/log/acme-issue.log}"

[ -x "$ACME_BIN" ] || { echo "错误: 找不到 acme.sh ($ACME_BIN)" >&2; exit 1; }
[ $# -ge 1 ] || { echo "用法: $(basename "$0") <主域名> [备用域名...]" >&2; exit 2; }

DOMAIN="$1"; shift
EXTRA=("$@")

COMMON=(--server "$ACME_SERVER")
[ "${INSECURE:-0}" = "1" ] && COMMON+=(--insecure)
[ -n "${EAB_KID:-}" ] && COMMON+=(--eab-kid "$EAB_KID")
[ -n "${EAB_HMAC_KEY:-}" ] && COMMON+=(--eab-hmac-key "$EAB_HMAC_KEY")

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

log "===== 申请证书: $DOMAIN ${EXTRA[*]:-} (KEYLEN=$KEYLEN) ====="

ISSUE=("$ACME_BIN" --issue "${COMMON[@]}" --keylength "$KEYLEN")
if [ -n "${ACME_DNS:-}" ]; then
  ISSUE+=(--dns "$ACME_DNS" --dnssleep "${DNS_SLEEP:-30}")
  log "验证方式: DNS-01 ($ACME_DNS, 无需 80 端口; 凭据取自环境变量)"
elif [ -n "${WEBROOT:-}" ]; then
  ISSUE+=(--webroot "$WEBROOT")
  log "验证方式: webroot ($WEBROOT)"
else
  ISSUE+=(--standalone)
  log "验证方式: standalone (临时占用 80 端口)"
fi
ISSUE+=(-d "$DOMAIN")
for d in "${EXTRA[@]:-}"; do [ -n "$d" ] && ISSUE+=(-d "$d"); done

if ! "${ISSUE[@]}" 2>&1 | tee -a "$LOG"; then
  log "签发失败，请检查上面的错误输出"
  exit 1
fi

mkdir -p "$CERTDIR/$DOMAIN"
INSTALL=("$ACME_BIN" --install-cert "${COMMON[@]}" -d "$DOMAIN"
  --key-file       "$CERTDIR/$DOMAIN/privkey.pem"
  --fullchain-file "$CERTDIR/$DOMAIN/fullchain.pem"
  --cert-file      "$CERTDIR/$DOMAIN/cert.pem"
  --ca-file        "$CERTDIR/$DOMAIN/ca.pem"
  --reloadcmd      "${RELOADCMD:-true}")

if ! "${INSTALL[@]}" 2>&1 | tee -a "$LOG"; then
  log "证书安装失败"
  exit 1
fi

chmod 700 "$CERTDIR" "$CERTDIR/$DOMAIN"
chmod 600 "$CERTDIR/$DOMAIN/privkey.pem"
chmod 644 "$CERTDIR/$DOMAIN/fullchain.pem" "$CERTDIR/$DOMAIN/cert.pem" "$CERTDIR/$DOMAIN/ca.pem"

log "完成。证书目录: $CERTDIR/$DOMAIN"
openssl x509 -in "$CERTDIR/$DOMAIN/fullchain.pem" -noout -subject -issuer -dates 2>/dev/null | tee -a "$LOG"
