#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ocserv 管理面板 —— 卸载脚本
set -euo pipefail
PREFIX=/opt/ocserv-panel
[ $# -ge 1 ] && PREFIX="$1"
[ "$(id -u)" = "0" ] || { echo "请用 root 运行" >&2; exit 1; }

echo "==> 停止并禁用服务"
systemctl disable --now ocserv-panel 2>/dev/null || true
rm -f /etc/systemd/system/ocserv-panel.service
systemctl daemon-reload

echo "==> 删除程序目录 $PREFIX"
rm -rf "$PREFIX"

echo "完成。（ocserv 本体、证书、续期脚本都未改动）"
