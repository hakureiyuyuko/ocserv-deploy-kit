#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================================
#  ocserv 安装脚本
#
#  用法:
#    sudo ./install.sh --panel-port 19999 --admin-password '你的面板密码'
#
#  参数:
#    --panel-port N        面板端口 (默认 19999)
#    --admin-password PW   面板管理员密码 (不填则随机生成并打印)
#    --panel-host IP       面板监听地址 (默认 0.0.0.0)
#    --panel-title TXT     面板标题
#    --no-node             不自动安装 Node.js (已自备 >= 18 时)
#    -h, --help            显示本帮助
#
#  装完后在面板「配置向导」里配置域名、证书、VPN 用户, 应用后自动启动 ocserv。
#  已装过的机器重跑本脚本 = 升级（保留现有配置，只覆盖显式传入的参数）。
# ============================================================================
set -euo pipefail

KIT_VERSION="1.5.0"

PANEL_PORT=19999
PANEL_HOST="0.0.0.0"
PANEL_TITLE="ocserv 管理面板"
PANEL_PREFIX=/opt/ocserv-panel
# 只有用户显式给过的面板参数才往面板安装脚本里传，否则重跑时不带参数 = 保持现状
G_PORT=0
G_HOST=0
G_TITLE=0
ADMIN_PASSWORD=""
NO_NODE=""
SRC="$(cd "$(dirname "$0")" && pwd)"

usage() { awk 'NR>1 && /^# ={20,}/{n++; if (n==2) exit; next} NR>1 && /^# SPDX-License-Identifier/{next} NR>1 && /^#/{sub(/^# ?/,""); print}' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --panel-port)      PANEL_PORT="$2"; G_PORT=1; shift 2;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2;;
    --panel-host)      PANEL_HOST="$2"; G_HOST=1; shift 2;;
    --panel-title)     PANEL_TITLE="$2"; G_TITLE=1; shift 2;;
    --no-node)         NO_NODE=1; shift;;
    -h|--help)         usage; exit 0;;
    *) echo "未知参数: $1" >&2; usage; exit 1;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "请用 root 运行" >&2; exit 1; }

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[警告] %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 1. 依赖
say "1/4 安装依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ocserv socat curl openssl ca-certificates cron >/dev/null
echo "    ocserv $(/usr/sbin/ocserv --version 2>&1 | head -1 | awk '{print $NF}')"

# ---------------------------------------------------------------- 2. 面板
say "2/4 安装管理面板"
[ -x "$SRC/ocserv-panel/install.sh" ] || { echo "找不到 $SRC/ocserv-panel/install.sh" >&2; exit 1; }
PANEL_ARGS=()
[ "$G_HOST" = "1" ] && PANEL_ARGS+=(--host "$PANEL_HOST")
[ "$G_PORT" = "1" ] && PANEL_ARGS+=(--port "$PANEL_PORT")
[ "$G_TITLE" = "1" ] && PANEL_ARGS+=(--title "$PANEL_TITLE")
[ -n "$ADMIN_PASSWORD" ] && PANEL_ARGS+=(--admin-password "$ADMIN_PASSWORD")
[ -n "$NO_NODE" ] && PANEL_ARGS+=(--no-node)
( cd "$SRC/ocserv-panel" && ./install.sh ${PANEL_ARGS[@]+"${PANEL_ARGS[@]}"} )

# ---------------------------------------------------------------- 3. 服务
say "3/4 准备 ocserv 服务"
# 装包时 ocserv 会被自动启用并启动，但此刻还没有证书，启动必然失败；先停用，
# 等面板配置完成后由面板启用并启动。
systemctl disable --now ocserv 2>/dev/null || true
echo "    ocserv: $(systemctl is-active ocserv 2>&1) / $(systemctl is-enabled ocserv 2>&1)"

# ---------------------------------------------------------------- 4. 汇总
say "4/4 完成"
if [ -z "$ADMIN_PASSWORD" ] && [ -f "$PANEL_PREFIX/admin-cred.txt" ]; then
  ADMIN_PASSWORD="$(sed -n 's/^密码:[[:space:]]*//p' "$PANEL_PREFIX/admin-cred.txt" | head -1)"
fi
DISPLAY_HOST="$PANEL_HOST"
# 用实际生效的配置打印地址（升级时可能沿用旧端口/旧监听地址）
CFG_PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$PANEL_PREFIX/config.json" 2>/dev/null | head -1)"
CFG_HOST="$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PANEL_PREFIX/config.json" 2>/dev/null | head -1)"
[ -n "$CFG_PORT" ] && PANEL_PORT="$CFG_PORT"
[ -n "$CFG_HOST" ] && DISPLAY_HOST="$CFG_HOST"
case "$DISPLAY_HOST" in
  0.0.0.0|::)
    DISPLAY_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$DISPLAY_HOST" ] || DISPLAY_HOST="$(hostname)"
    ;;
esac

cat <<EOF

  面板地址   : http://$DISPLAY_HOST:$PANEL_PORT/
  管理员账号 : admin
  管理员密码 : $ADMIN_PASSWORD
  凭据文件   : $PANEL_PREFIX/admin-cred.txt

  下一步: 打开上面的地址登录, 在「配置向导」里填域名 / 证书 / VPN 用户, 应用后 ocserv 会自动启动。
EOF
