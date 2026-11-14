#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================
#  容器入口：按环境变量生成配置 → 起 ocserv（可被拉起重启）→ 起面板
#
#  说明：容器里没有 systemd，面板的「服务启停 / 配置向导第 4 步 / 日志页」
#        依赖 systemctl 的功能不可用；配置由下面的环境变量负责。
#  环境变量：
#    OC_DOMAIN   证书域名（默认 vpn.example.com）
#    OC_PORT     VPN 端口（默认 443，tcp+udp）
#    OC_NET/OC_MASK  客户端网段（默认 10.66.66.0 / 255.255.255.0）
#    OC_DNS1/OC_DNS2 下发 DNS（默认 1.1.1.1 / 8.8.8.8）
#    VPN_USER / VPN_PASS  首次启动创建的用户（可选）
#    PANEL_PORT  面板端口（默认 19999）
#    PANEL_ADMIN_PASSWORD  面板管理员密码（可选；不给则随机生成写 admin-cred.txt）
#    ENABLE_NAT  1=容器内做 MASQUERADE（默认 1，需 --cap-add NET_ADMIN）
#    OC_OUTIF    出口网卡（默认自动探测）
# ============================================================
set -uo pipefail

log() { echo "[entrypoint] $*"; }

CONF=/etc/ocserv/ocserv.conf
TPL=/opt/ocserv-panel/templates/ocserv.conf.tpl
DOMAIN="${OC_DOMAIN:-vpn.example.com}"
PORT="${OC_PORT:-443}"
NET="${OC_NET:-10.66.66.0}"
MASK="${OC_MASK:-255.255.255.0}"
DNS1="${OC_DNS1:-1.1.1.1}"
DNS2="${OC_DNS2:-8.8.8.8}"
CERTDIR="/etc/ssl/securev/$DOMAIN"
PANEL_PORT="${PANEL_PORT:-19999}"
PANEL_DIR=/opt/ocserv-panel
ENABLE_NAT="${ENABLE_NAT:-1}"
OC_OUTIF="${OC_OUTIF:-}"

mkdir -p /etc/ocserv "$CERTDIR" /var/lib/ocserv-panel /var/log
chmod 700 /etc/ssl/securev 2>/dev/null

# ---------------------------------------------------------------- 1. ocserv.conf
if [ -f "$CONF" ]; then
  log "沿用已有配置 $CONF"
else
  log "生成 $CONF（域名 $DOMAIN，端口 $PORT，网段 $NET/$MASK）"
  DOMAIN="$DOMAIN" VPN_PORT="$PORT" VPN_NET="$NET" VPN_MASK="$MASK" DNS1="$DNS1" DNS2="$DNS2" \
  node -e '
    const fs = require("fs");
    const T = require("/opt/ocserv-panel/lib/tpl");
    const tpl = fs.readFileSync("/opt/ocserv-panel/templates/ocserv.conf.tpl", "utf8");
    process.stdout.write(T.renderConf(tpl, {
      domain: process.env.DOMAIN, vpnPort: process.env.VPN_PORT, vpnNet: process.env.VPN_NET,
      vpnMask: process.env.VPN_MASK, dns1: process.env.DNS1, dns2: process.env.DNS2
    }));
  ' > "$CONF" || { log "!! 模板渲染失败"; exit 1; }
fi


# ---------------------------------------------------------------- 2. 证书
if [ -s "$CERTDIR/fullchain.pem" ] && [ -s "$CERTDIR/privkey.pem" ]; then
  log "使用已有证书 $CERTDIR"
else
  log "未提供证书：生成 30 天自签证书（客户端会提示不受信任）"
  mkdir -p "$CERTDIR"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" \
    -keyout "$CERTDIR/privkey.pem" -out "$CERTDIR/fullchain.pem" >/dev/null 2>&1 \
    || { log "!! 自签证书生成失败"; exit 1; }
  cp "$CERTDIR/fullchain.pem" "$CERTDIR/cert.pem"
  cp "$CERTDIR/fullchain.pem" "$CERTDIR/ca.pem"
  chmod 600 "$CERTDIR/privkey.pem"
fi

if /usr/sbin/ocserv -c "$CONF" --test-config >/tmp/confcheck.log 2>&1; then
  log "配置自检通过"
else
  log "!! 配置自检失败："; sed -n '1,10p' /tmp/confcheck.log
  exit 1
fi

# ---------------------------------------------------------------- 3. 用户
if [ -n "${VPN_USER:-}" ] && [ -n "${VPN_PASS:-}" ]; then
  if [ -f /etc/ocserv/ocpasswd ] && grep -q "^$VPN_USER:" /etc/ocserv/ocpasswd 2>/dev/null; then
    log "用户 $VPN_USER 已存在，跳过"
  else
    printf '%s\n%s\n' "$VPN_PASS" "$VPN_PASS" | ocpasswd -c /etc/ocserv/ocpasswd "$VPN_USER" >/dev/null 2>&1 \
      && log "已创建用户 $VPN_USER" || log "!! 创建用户 $VPN_USER 失败"
  fi
fi

# ---------------------------------------------------------------- 4. 转发/NAT
if [ "$ENABLE_NAT" = "1" ]; then
  if [ -z "$OC_OUTIF" ]; then
    OC_OUTIF="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
  fi
  if [ -z "$OC_OUTIF" ]; then
    log "!! 探测不到出口网卡，跳过 NAT（客户端无法上网，只能访问本机）"
  else
    sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || log "!! 无法设置 ip_forward（需 --cap-add NET_ADMIN）"
    iptables -t nat -C POSTROUTING -s "$NET/24" -o "$OC_OUTIF" -j MASQUERADE 2>/dev/null \
      || iptables -t nat -A POSTROUTING -s "$NET/24" -o "$OC_OUTIF" -j MASQUERADE 2>/dev/null \
      || log "!! 添加 MASQUERADE 失败"
    iptables -C FORWARD -s "$NET/24" -j ACCEPT 2>/dev/null || iptables -A FORWARD -s "$NET/24" -j ACCEPT 2>/dev/null
    iptables -C FORWARD -d "$NET/24" -j ACCEPT 2>/dev/null || iptables -A FORWARD -d "$NET/24" -j ACCEPT 2>/dev/null
    log "NAT 就绪：$NET/24 -> $OC_OUTIF"
  fi
fi

# ---------------------------------------------------------------- 5. 面板配置
if [ ! -s /var/lib/ocserv-panel/config.json ]; then
  log "写入面板配置（端口 $PANEL_PORT）"
  cat > /var/lib/ocserv-panel/config.json <<JSON
{
  "host": "0.0.0.0",
  "port": $PANEL_PORT,
  "title": "ocserv 管理面板",
  "ocservConf": "/etc/ocserv/ocserv.conf",
  "ocpasswd": "/etc/ocserv/ocpasswd",
  "ocservBin": "/usr/sbin/ocserv",
  "ocservService": "ocserv",
  "acmeDomain": "$DOMAIN",
  "acmeBin": "/root/.acme.sh/acme.sh",
  "certFile": "$CERTDIR/fullchain.pem",
  "keyFile": "$CERTDIR/privkey.pem",
  "vpnNet": "$NET"
}
JSON
  chmod 600 /var/lib/ocserv-panel/config.json
fi
if [ -n "${PANEL_ADMIN_PASSWORD:-}" ]; then
  node "$PANEL_DIR/server.js" --set-password admin "$PANEL_ADMIN_PASSWORD" >/dev/null 2>&1 \
    && log "面板管理员密码已设置为环境变量提供的值"
fi

# ---------------------------------------------------------------- 6. 启进程
PANEL_PID=""
OC_SUP_PID=""

cleanup() {
  log "收到退出信号，停止子进程"
  touch /run/ocserv.halt
  [ -f /run/ocserv.pid ] && kill "$(cat /run/ocserv.pid)" 2>/dev/null
  [ -n "$OC_SUP_PID" ] && kill "$OC_SUP_PID" 2>/dev/null
  [ -n "$PANEL_PID" ] && kill "$PANEL_PID" 2>/dev/null
  exit 0
}
trap cleanup TERM INT

if [ ! -e /dev/net/tun ]; then
  log "!! 没有 /dev/net/tun：ocserv 无法启动。运行时请加 --device /dev/net/tun --cap-add NET_ADMIN"
else
  (
    while :; do
      /usr/sbin/ocserv -c "$CONF" -f &
      echo $! > /run/ocserv.pid
      wait $!
      rc=$?
      [ -f /run/ocserv.halt ] && exit 0
      log "ocserv 退出（rc=$rc），2 秒后重启"
      sleep 2
    done
  ) &
  OC_SUP_PID=$!
  log "ocserv 已启动（$PORT tcp/udp）"
fi

node "$PANEL_DIR/server.js" &
PANEL_PID=$!
log "面板已启动：http://0.0.0.0:$PANEL_PORT/（初始账号见 /var/lib/ocserv-panel/admin-cred.txt）"

wait -n
cleanup
