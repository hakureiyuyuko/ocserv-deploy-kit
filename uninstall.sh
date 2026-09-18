#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================================
#  ocserv 部署套件 —— 卸载脚本
#
#  用法:
#    sudo ./uninstall.sh [选项]
#
#  选项:
#    --purge             连配置一起删: /etc/ocserv、/etc/ssl/securev、/root/.acme.sh
#                        （证书、VPN 用户、DNS API 凭据都会消失，不可恢复）
#    --remove-packages   再用 apt 卸载 ocserv 软件包
#    --yes, -y           不交互确认（脚本/非 tty 环境必须加）
#    -h, --help          显示本帮助
#
#  默认只卸「本套件装的东西」:
#    面板服务与程序目录、ocserv NAT/转发单元（含 iptables 规则）、证书续期任务。
#    ocserv 配置、VPN 用户、证书、acme.sh 账号都会保留，方便以后重装或用别的面板接管。
#
#  环境变量(一般不用设): PREFIX / UNIT_FILE / NAT_UNIT / OCSERV_DIR / CERT_DIR /
#                        ACME_HOME / RENEW_SCRIPT / RENEW_LOG / KIT_ROOT(仅测试)
# ============================================================================
set -euo pipefail

KIT_ROOT="${KIT_ROOT:-}"
UNIT_FILE="${UNIT_FILE:-$KIT_ROOT/etc/systemd/system/ocserv-panel.service}"
NAT_UNIT="${NAT_UNIT:-$KIT_ROOT/etc/systemd/system/ocserv-nat.service}"
OCSERV_DIR="${OCSERV_DIR:-$KIT_ROOT/etc/ocserv}"
CERT_DIR="${CERT_DIR:-$KIT_ROOT/etc/ssl/securev}"
ACME_HOME="${ACME_HOME:-$KIT_ROOT/root/.acme.sh}"
RENEW_SCRIPT="${RENEW_SCRIPT:-$KIT_ROOT/usr/local/bin/acme-renew.sh}"
RENEW_LOG="${RENEW_LOG:-$KIT_ROOT/var/log/acme-renew.log}"
OCSERV_SERVICE="${OCSERV_SERVICE:-ocserv}"
PANEL_SERVICE="$(basename "$UNIT_FILE" .service)"

PURGE=0
REMOVE_PKGS=0
ASSUME_YES=0

usage() { awk 'NR>1 && /^# ={20,}/{n++; if (n==2) exit; next} NR>1 && /^# SPDX-License-Identifier/{next} NR>1 && /^#/{sub(/^# ?/,""); print}' "$0"; }
say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[警告] %s\033[0m\n' "$*"; }
die()  { printf '[错误] %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)           PURGE=1; shift;;
    --remove-packages) REMOVE_PKGS=1; shift;;
    --yes|-y)          ASSUME_YES=1; shift;;
    -h|--help)         usage; exit 0;;
    *) die "未知参数: $1（-h 看帮助）";;
  esac
done

[ "$(id -u)" = "0" ] || die "请用 root 运行（sudo ./uninstall.sh）"

# ---------------------------------------------------------------- 找已装的面板
if [ -z "${PREFIX:-}" ]; then
  PREFIX="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" 2>/dev/null | head -1 || true)"
fi
[ -n "${PREFIX:-}" ] || PREFIX=/opt/ocserv-panel

if [ ! -f "$UNIT_FILE" ] && [ ! -f "$PREFIX/server.js" ]; then
  warn "没找到已安装的面板（$UNIT_FILE / $PREFIX 都不存在），可能已经卸载过；仍会继续清理其余项目。"
fi

safe_rm_rf() { [ -n "${1:-}" ] && [ "$1" != "/" ] && rm -rf -- "$1"; }

# ---------------------------------------------------------------- 确认
printf '\033[1m将执行以下操作:\033[0m\n'
printf '  [删除] 面板服务 %s 与程序目录 %s\n' "$PANEL_SERVICE" "$PREFIX"
printf '  [删除] ocserv NAT/转发单元 ocserv-nat（含 iptables 规则）\n'
printf '  [删除] 证书续期任务(crontab) 与 %s\n' "$RENEW_SCRIPT"
printf '  [停止] %s 服务（默认不删它的配置）\n' "$OCSERV_SERVICE"
if [ "$PURGE" = "1" ]; then
  printf '\033[1;31m  [删除] %s（ocserv 配置与 VPN 用户）\033[0m\n' "$OCSERV_DIR"
  printf '\033[1;31m  [删除] %s（证书私钥）\033[0m\n' "$CERT_DIR"
  printf '\033[1;31m  [删除] %s（acme.sh 账号与 DNS API 凭据）\033[0m\n' "$ACME_HOME"
  printf '\033[1;31m  [删除] %s（续期日志）\033[0m\n' "$RENEW_LOG"
else
  printf '  [保留] %s（配置与 VPN 用户）、%s（证书）、%s（证书账号）\n' "$OCSERV_DIR" "$CERT_DIR" "$ACME_HOME"
  printf '         （要连这些一起删，用 --purge）\n'
fi
if [ "$REMOVE_PKGS" = "1" ]; then
  printf '  [删除] apt 卸载 ocserv 软件包\n'
fi

if [ "$ASSUME_YES" != "1" ]; then
  if [ ! -t 0 ]; then
    die "当前不是交互终端，确认请显式加 --yes"
  fi
  printf '\n确认继续? [y/N] '
  read -r _ans || _ans=""
  case "$_ans" in y|Y|yes|YES) ;; *) echo "已取消，什么都没做。"; exit 0;; esac
fi

# ---------------------------------------------------------------- 1. 面板
say "1/5 卸载管理面板"
if systemctl list-unit-files "${PANEL_SERVICE}.service" >/dev/null 2>&1; then
  systemctl disable --now "$PANEL_SERVICE" >/dev/null 2>&1 || true
fi
rm -f -- "$UNIT_FILE"
safe_rm_rf "$PREFIX"
echo "    已删除 $PREFIX"

# ---------------------------------------------------------------- 2. ocserv 服务
say "2/5 停止 ocserv 服务"
systemctl disable --now "$OCSERV_SERVICE" >/dev/null 2>&1 || true
echo "    $OCSERV_SERVICE: $(systemctl is-active "$OCSERV_SERVICE" 2>&1 || true) / $(systemctl is-enabled "$OCSERV_SERVICE" 2>&1 || true)"

# ---------------------------------------------------------------- 3. NAT 单元
say "3/5 删除 NAT/转发单元"
if [ -f "$NAT_UNIT" ]; then
  systemctl disable --now ocserv-nat >/dev/null 2>&1 || true
  rm -f -- "$NAT_UNIT"
  echo "    已删除 $NAT_UNIT 及其 iptables 规则"
else
  echo "    未安装，跳过"
fi
systemctl daemon-reload >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 4. 续期任务
say "4/5 删除证书续期任务"
if command -v crontab >/dev/null 2>&1 && crontab -l >/dev/null 2>&1; then
  _before="$(crontab -l 2>/dev/null | wc -l)"
  crontab -l 2>/dev/null | grep -v 'acme-renew\.sh' | crontab - 2>/dev/null || true
  _after="$(crontab -l 2>/dev/null | wc -l)"
  echo "    crontab: $_before 行 -> $_after 行"
else
  echo "    没有 crontab 任务，跳过"
fi
if [ -f "$RENEW_SCRIPT" ]; then
  rm -f -- "$RENEW_SCRIPT"
  echo "    已删除 $RENEW_SCRIPT"
fi

# ---------------------------------------------------------------- 5. 清理数据
say "5/5 清理"
if [ "$PURGE" = "1" ]; then
  for d in "$OCSERV_DIR" "$CERT_DIR" "$ACME_HOME"; do
    if [ -e "$d" ]; then safe_rm_rf "$d"; echo "    已删除 $d"; fi
  done
  if [ -f "$RENEW_LOG" ]; then
    rm -f -- "$RENEW_LOG"
    echo "    已删除 $RENEW_LOG"
  fi
else
  echo "    已保留 ocserv 配置 / 证书 / VPN 用户 / acme.sh 账号"
fi
if [ "$REMOVE_PKGS" = "1" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq remove -y --purge "$OCSERV_SERVICE" >/dev/null 2>&1 || warn "apt 卸载 ocserv 失败，请手动处理"
  echo "    已尝试 apt 卸载 $OCSERV_SERVICE"
fi

# ---------------------------------------------------------------- 结果
printf '\n\033[1;32m==> 卸载完成\033[0m\n'
if [ "$PURGE" = "1" ]; then
  printf '  已删除: 面板(%s)、NAT 单元、续期任务、ocserv 配置、证书、acme.sh 账号\n' "$PREFIX"
else
  printf '  已删除: 面板(%s)、NAT 单元、续期任务\n' "$PREFIX"
  printf '  已保留: %s 、%s 、%s（重装后可直接沿用）\n' "$OCSERV_DIR" "$CERT_DIR" "$ACME_HOME"
fi
