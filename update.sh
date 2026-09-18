#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================================
#  ocserv 部署套件 —— 更新脚本
#
#  用法:
#    sudo ./update.sh [额外参数...]
#
#  作用:
#    把已装好的「管理面板」升级到当前套件版本。只替换面板程序、模块、模板与
#    systemd 单元 —— 不碰 ocserv 的配置 / 证书 / VPN 用户 / 网段 / 续期任务，
#    也不重装依赖包，所以不会中断正在连接的 VPN 用户。
#
#  输出:
#    默认全静默 —— 只在失败时打印安装脚本的完整日志，成功时打印一行结果。
#
#  额外参数(透传给 ocserv-panel/install.sh):
#    --admin-password PW   顺便重设面板管理员密码
#    --reset-password      重置为随机密码
#    --no-node             不自动安装 Node.js
#    --force, -f           已是最新版本也强制重装一遍
#
#  环境变量(一般不用设):
#    PREFIX     面板安装目录(默认从 systemd 单元里读，再退回 /opt/ocserv-panel)
#    UNIT_FILE  面板 systemd 单元路径(默认 /etc/systemd/system/ocserv-panel.service)
#    KIT_ROOT   路径前缀，仅用于测试/容器(默认空)
# ============================================================================
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
KIT_ROOT="${KIT_ROOT:-}"
UNIT_FILE="${UNIT_FILE:-$KIT_ROOT/etc/systemd/system/ocserv-panel.service}"
LOG=""

die() { printf '[错误] %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
cleanup() { [ -n "$LOG" ] && rm -f "$LOG"; return 0; }
trap cleanup EXIT

usage() { awk 'NR>1 && /^# ={20,}/{n++; if (n==2) exit; next} NR>1 && /^# SPDX-License-Identifier/{next} NR>1 && /^#/{sub(/^# ?/,""); print}' "$0"; }

# ---------------------------------------------------------------- 参数
FORCE=0
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --force|-f) FORCE=1; shift;;
    -h|--help)  usage; exit 0;;
    *)          PASS_ARGS+=("$1"); shift;;
  esac
done

[ "$(id -u)" = "0" ] || die "请用 root 运行（sudo ./update.sh）"
[ -f "$SRC/ocserv-panel/install.sh" ] || die "找不到 $SRC/ocserv-panel/install.sh（请在解压后的套件目录内运行）"

# ---------------------------------------------------------------- 找已装的面板
if [ -z "${PREFIX:-}" ]; then
  PREFIX="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
fi
[ -n "${PREFIX:-}" ] || PREFIX=/opt/ocserv-panel
[ -f "$PREFIX/server.js" ] || die "没找到已安装的面板（$PREFIX/server.js）。首次安装请用: sudo ./install.sh --panel-port 19999 --admin-password '密码'"

# ---------------------------------------------------------------- 版本比较
ver_of() { sed -n "s/^[[:space:]]*\(const \)\?VERSION[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\2/p" "$1" 2>/dev/null | head -1; }
NEW_VER="$(ver_of "$SRC/ocserv-panel/server.js")"
CUR_VER="$(ver_of "$PREFIX/server.js")"
[ -n "$NEW_VER" ] || NEW_VER='?'
if [ -n "$CUR_VER" ] && [ "$CUR_VER" = "$NEW_VER" ] && [ "$FORCE" != "1" ]; then
  say "已是最新版本 $NEW_VER，无需更新。"
  exit 0
fi

# ---------------------------------------------------------------- 执行升级
LOG="$(mktemp "${TMPDIR:-/tmp}/ocserv-panel-update.XXXXXX")"
set +e
( cd "$SRC/ocserv-panel" && ./install.sh --prefix "$PREFIX" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} ) >"$LOG" 2>&1
CODE=$?
set -e

if [ "$CODE" != "0" ]; then
  printf '[错误] 面板更新失败（退出码 %s）。完整日志：%s\n' "$CODE" "$LOG" >&2
  printf -- '----------------------------------------------------------------\n' >&2
  cat "$LOG" >&2 || true
  printf -- '----------------------------------------------------------------\n' >&2
  printf '面板可能已停止：systemctl status ocserv-panel / journalctl -u ocserv-panel\n' >&2
  LOG=""   # 失败时保留日志文件，方便用户回看/上报
  exit "$CODE"
fi
rm -f "$LOG"; LOG=""

# ---------------------------------------------------------------- 结果（一行）
PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$PREFIX/config.json" 2>/dev/null | head -1)"
HOST="$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PREFIX/config.json" 2>/dev/null | head -1)"
case "$HOST" in
  ""|0.0.0.0|::) HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"; [ -n "$HOST" ] || HOST="$(hostname)";;
esac
if [ -n "$PORT" ]; then
  say "已更新到 $NEW_VER（面板：http://$HOST:$PORT/ ，ocserv 配置 / 证书 / 用户均未改动）。"
else
  say "已更新到 $NEW_VER（ocserv 配置 / 证书 / 用户均未改动）。"
fi
