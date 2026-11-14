#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================================
#  ocserv-deploy-kit —— Alpine 一键安装
#  二进制（ocserv 1.6.0 / Node 24）与依赖库都在包里，不需要从仓库拉
#  用法:  sudo ./install.sh [--panel-port N] [--admin-password PW]
# ============================================================================
set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)

PREFIX=/opt/ocserv-deploy-kit
PANEL=/opt/ocserv-panel
PANEL_PORT=19999
ADMIN_PASSWORD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --panel-port)     PANEL_PORT="$2"; shift 2;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2;;
    -h|--help)
      sed -n '4,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0;;
    *) echo "未知参数: $1" >&2; exit 1;;
  esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[警告] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行"
command -v apk >/dev/null 2>&1 || die "这个包只用于 Alpine（找不到 apk）"
[ "$(uname -m)" = "x86_64" ] || die "本包只含 x86_64 二进制，当前是 $(uname -m)"

say "1/5 运行时依赖"
apk add --no-cache iptables ca-certificates openssl >/dev/null 2>&1 \
  || warn "apk 装包失败（离线？）—— 请自行确保 iptables / openssl / ca-certificates 可用"

say "2/5 部署二进制与面板"
mkdir -p "$PREFIX/bin" "$PREFIX/lib" "$PANEL"
cp -a "$SRC/bin/." "$PREFIX/bin/"
cp -a "$SRC/lib/." "$PREFIX/lib/"
chmod 755 "$PREFIX/bin/"*
rm -rf "$PANEL/server.js" "$PANEL/lib" "$PANEL/public" "$PANEL/templates"
cp -a "$SRC/ocserv-panel/." "$PANEL/"

mkdir -p /etc/ocserv /etc/ssl/securev /usr/local/sbin
chmod 700 /etc/ssl/securev

# 命令入口（不覆盖系统已有的同名命令）
if [ ! -e /usr/local/sbin/ocserv ]; then
  printf '#!/bin/sh\nexec %s/bin/ocserv "$@"\n' "$PREFIX" > /usr/local/sbin/ocserv
  chmod 755 /usr/local/sbin/ocserv
fi

# ocserv 运行用户（模板里 run-as-user = ocserv）
addgroup -S ocserv 2>/dev/null || true
adduser -S -D -H -s /sbin/nologin -G ocserv ocserv 2>/dev/null || true

say "3/5 面板配置"
if [ -f "$PANEL/config.json" ]; then
  OLD_PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$PANEL/config.json" 2>/dev/null | head -1)
  [ -n "${OLD_PORT:-}" ] && PANEL_PORT="$OLD_PORT"
fi
if [ ! -f "$PANEL/config.json" ]; then
  cat > "$PANEL/config.json" <<JSON
{
  "host": "0.0.0.0",
  "port": $PANEL_PORT,
  "title": "ocserv 管理面板",
  "ocservConf": "/etc/ocserv/ocserv.conf",
  "ocpasswd": "/etc/ocserv/ocpasswd",
  "ocservBin": "$PREFIX/bin/ocserv",
  "ocservService": "ocserv",
  "acmeDomain": "",
  "acmeBin": "/root/.acme.sh/acme.sh",
  "certFile": "",
  "keyFile": ""
}
JSON
  chmod 600 "$PANEL/config.json"
fi
if [ -n "$ADMIN_PASSWORD" ]; then
  "$PREFIX/bin/node" "$PANEL/server.js" --set-password admin "$ADMIN_PASSWORD" >/dev/null
fi

say "4/5 OpenRC 服务"
if ! command -v rc-service >/dev/null 2>&1; then
  warn "没有 OpenRC（rc-service），尝试安装"
  apk add --no-cache openrc >/dev/null 2>&1 || true
fi
command -v rc-service >/dev/null 2>&1 || warn "OpenRC 仍不可用：服务不会自动托管，可用手动方式启动"
mkdir -p /etc/init.d
install -m 755 "$SRC/openrc/ocserv" /etc/init.d/ocserv
install -m 755 "$SRC/openrc/ocserv-panel" /etc/init.d/ocserv-panel
rc-update add ocserv-panel default >/dev/null 2>&1 || true
rc-service ocserv-panel restart >/dev/null 2>&1 || rc-service ocserv-panel start >/dev/null 2>&1 \
  || warn "面板启动失败，看 /var/log/ocserv-panel.log"
if [ -f /etc/ocserv/ocserv.conf ]; then
  rc-update add ocserv default >/dev/null 2>&1 || true
  rc-service ocserv restart >/dev/null 2>&1 || true
else
  echo "    ocserv 尚未配置，先不启用服务（面板配置向导第 4 步会自动启用）"
fi

say "5/5 完成"
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
[ -n "${IP:-}" ] || IP=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
cat <<EOF
  版本:      $VERSION（Alpine 包）
  面板:      http://${IP:-<本机IP>}:$PANEL_PORT/
  初始账号:  cat $PANEL/admin-cred.txt
  下一步:    面板「配置向导」→ 域名 / 证书 / 用户 → 第 4 步应用
  注意:      ocserv 需要 /dev/net/tun；容器/LXC 里要放设备并放行端口
EOF
