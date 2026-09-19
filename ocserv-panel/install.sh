#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================
#  ocserv 管理面板 —— 安装脚本 (零依赖, 仅需 Node.js >= 18)
#  用法: sudo ./install.sh [选项]
# ============================================================
set -euo pipefail

PREFIX=/opt/ocserv-panel
HOST=0.0.0.0
PORT=19999
HTTPS=false
TITLE="ocserv 管理面板"
CERT=""
KEY=""
OCSERV_CONF=/etc/ocserv/ocserv.conf
OCPASSWD=/etc/ocserv/ocpasswd
OCSERV_BIN=/usr/sbin/ocserv
OCSERV_SERVICE=ocserv
ACME_DOMAIN=""
ACME_BIN=/root/.acme.sh/acme.sh
ACME_SERVER=https://acme-v02.api.letsencrypt.org/directory
RENEW_SCRIPT=/usr/local/bin/acme-renew.sh
RENEW_LOG=/var/log/acme-renew.log
VPN_NET=""
AUTO_NODE=1
FORCE_PW=0
ADMIN_PASSWORD=""
# 记录命令行**显式**给过的配置项：升级/重装时没给的项一律沿用现有 config.json，
# 避免把「配置向导」填进去的域名/证书/端口/网段覆盖回默认值。
GIVEN=" "

SRC="$(cd "$(dirname "$0")" && pwd)"

usage() {
cat <<'U'
选项:
  --prefix DIR          安装目录 (默认 /opt/ocserv-panel)
  --host IP             监听地址 (默认 0.0.0.0；只让内网访问就填内网 IP)
  --port N              监听端口 (默认 19999)
  --https               启用 HTTPS (需同时给 --cert/--key；按 IP 访问会有证书名不匹配告警，内网一般不用)
  --cert FILE           fullchain.pem 路径
  --key  FILE           privkey.pem 路径
  --title "文字"         面板标题
  --ocserv-conf FILE    ocserv 配置文件 (默认 /etc/ocserv/ocserv.conf)
  --ocpasswd FILE       ocserv 用户库 (默认 /etc/ocserv/ocpasswd)
  --ocserv-bin FILE     ocserv 可执行文件 (默认 /usr/sbin/ocserv)
  --ocserv-service NAME systemd 服务名 (默认 ocserv)
  --acme-domain DOMAIN  ACME 域名，用于证书/续期信息展示
  --acme-bin FILE       acme.sh 路径 (默认 /root/.acme.sh/acme.sh)
  --acme-server URL     ACME 服务器
  --renew-script FILE   续期脚本路径 (默认 /usr/local/bin/acme-renew.sh)
  --renew-log FILE      续期日志路径 (默认 /var/log/acme-renew.log)
  --vpn-net CIDR        VPN 客户端网段(仅记录到 config.json 供查考)
  --no-node             不自动安装 Node.js
  --admin-password PW   直接指定管理员密码(不写则随机生成并打印到 admin-cred.txt)
  --reset-password      重装时重置管理员密码
  -h, --help            显示帮助
U
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)         PREFIX="$2"; shift 2;;
    --host)           HOST="$2"; GIVEN="$GIVEN host"; shift 2;;
    --port)           PORT="$2"; GIVEN="$GIVEN port"; shift 2;;
    --https)          HTTPS=true; GIVEN="$GIVEN https"; shift;;
    --cert)           CERT="$2"; GIVEN="$GIVEN certFile"; shift 2;;
    --key)            KEY="$2"; GIVEN="$GIVEN keyFile"; shift 2;;
    --title)          TITLE="$2"; GIVEN="$GIVEN title"; shift 2;;
    --ocserv-conf)    OCSERV_CONF="$2"; GIVEN="$GIVEN ocservConf"; shift 2;;
    --ocpasswd)       OCPASSWD="$2"; GIVEN="$GIVEN ocpasswd"; shift 2;;
    --ocserv-bin)     OCSERV_BIN="$2"; GIVEN="$GIVEN ocservBin"; shift 2;;
    --ocserv-service) OCSERV_SERVICE="$2"; GIVEN="$GIVEN ocservService"; shift 2;;
    --acme-domain)    ACME_DOMAIN="$2"; GIVEN="$GIVEN acmeDomain certFile keyFile"; shift 2;;
    --acme-bin)       ACME_BIN="$2"; GIVEN="$GIVEN acmeBin"; shift 2;;
    --acme-server)    ACME_SERVER="$2"; GIVEN="$GIVEN acmeServer"; shift 2;;
    --renew-script)   RENEW_SCRIPT="$2"; GIVEN="$GIVEN renewScript"; shift 2;;
    --renew-log)      RENEW_LOG="$2"; GIVEN="$GIVEN renewLog"; shift 2;;
    --vpn-net)        VPN_NET="$2"; GIVEN="$GIVEN vpnNet"; shift 2;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2;;
    --no-node)        AUTO_NODE=0; shift;;
    --reset-password) FORCE_PW=1; shift;;
    -h|--help)        usage; exit 0;;
    *) echo "未知参数: $1" >&2; usage; exit 1;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "请用 root 运行" >&2; exit 1; }
[ -f "$SRC/server.js" ] || { echo "找不到 $SRC/server.js（请在解压后的目录内运行）" >&2; exit 1; }

# 证书默认路径
if [ -n "$ACME_DOMAIN" ]; then
  [ -n "$CERT" ] || CERT="/etc/ssl/securev/$ACME_DOMAIN/fullchain.pem"
  [ -n "$KEY" ]  || KEY="/etc/ssl/securev/$ACME_DOMAIN/privkey.pem"
fi

echo "==> 1/6 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  if [ "$AUTO_NODE" = "1" ]; then
    echo "    未安装，正在通过 apt 安装 nodejs ..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq nodejs
  else
    echo "    未安装 Node.js，请先安装 (>=18) 或去掉 --no-node" >&2; exit 1
  fi
fi
NODE_BIN="$(command -v node)"
echo "    $(node -v) @ $NODE_BIN"
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' \
  || { echo "    Node 版本过低，需要 >= 18" >&2; exit 1; }

# 升级/重装：命令行没显式给的配置项一律沿用现有 config.json
# （否则会把「配置向导」填的域名/证书路径/端口/网段覆盖回默认值）
if [ -f "$PREFIX/config.json" ]; then
  while IFS=$'\t' read -r _k _v; do
    [ -n "$_k" ] || continue
    case "$_k" in
      title)         TITLE="$_v";;
      host)          HOST="$_v";;
      port)          PORT="$_v";;
      https)         HTTPS="$_v";;
      certFile)      CERT="$_v";;
      keyFile)       KEY="$_v";;
      vpnNet)        VPN_NET="$_v";;
      acmeDomain)    ACME_DOMAIN="$_v";;
      acmeBin)       ACME_BIN="$_v";;
      acmeServer)    ACME_SERVER="$_v";;
      renewScript)   RENEW_SCRIPT="$_v";;
      renewLog)      RENEW_LOG="$_v";;
      ocservConf)    OCSERV_CONF="$_v";;
      ocpasswd)      OCPASSWD="$_v";;
      ocservBin)     OCSERV_BIN="$_v";;
      ocservService) OCSERV_SERVICE="$_v";;
    esac
  done < <("$NODE_BIN" -e '
    const fs = require("fs");
    let c = {};
    try { c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) || {}; } catch (e) {}
    const given = String(process.argv[2] || "").split(/\s+/).filter(Boolean);
    const keys = ["title","host","port","https","certFile","keyFile","vpnNet","acmeDomain",
                  "acmeBin","acmeServer","renewScript","renewLog","ocservConf","ocpasswd",
                  "ocservBin","ocservService"];
    for (const k of keys) {
      if (given.indexOf(k) >= 0) continue;
      const v = c[k];
      if (v === undefined || v === null) continue;
      const s = String(v).replace(/[\t\r\n]/g, " ");
      if (s === "") continue;
      console.log(k + "\t" + s);
    }
  ' "$PREFIX/config.json" "$GIVEN")
fi

echo "==> 2/6 复制程序文件到 $PREFIX"
mkdir -p "$PREFIX/public"
install -m 755 "$SRC/server.js" "$PREFIX/server.js"
install -m 644 "$SRC/public/index.html" "$PREFIX/public/index.html"
# 纯函数模块(模板渲染/单元生成)
if [ -d "$SRC/lib" ]; then
  mkdir -p "$PREFIX/lib"
  for f in "$SRC"/lib/*; do
    [ -f "$f" ] && install -m 644 "$f" "$PREFIX/lib/$(basename "$f")"
  done
  echo "    模块: $(ls "$PREFIX/lib" 2>/dev/null | tr '\n' ' ')"
fi
# 配置向导用的模板(ocserv.conf / 续期脚本); 缺失时向导会提示
if [ -d "$SRC/templates" ]; then
  mkdir -p "$PREFIX/templates"
  for t in "$SRC"/templates/*; do
    [ -f "$t" ] && install -m 644 "$t" "$PREFIX/templates/$(basename "$t")"
  done
  echo "    模板: $(ls "$PREFIX/templates" 2>/dev/null | tr '\n' ' ')"
fi

echo "==> 3/6 生成 config.json"
NEW_CFG="$(mktemp)"
cat > "$NEW_CFG" <<EOF
{
  "title": "$TITLE",
  "port": $PORT,
  "host": "$HOST",
  "https": $HTTPS,
  "certFile": "$CERT",
  "keyFile": "$KEY",
  "ocservConf": "$OCSERV_CONF",
  "ocpasswd": "$OCPASSWD",
  "ocservBin": "$OCSERV_BIN",
  "ocservService": "$OCSERV_SERVICE",
  "acmeDomain": "$ACME_DOMAIN",
  "acmeBin": "$ACME_BIN",
  "acmeServer": "$ACME_SERVER",
  "renewScript": "$RENEW_SCRIPT",
  "renewLog": "$RENEW_LOG",
  "vpnNet": "$VPN_NET"
}
EOF
if [ -f "$PREFIX/config.json" ]; then
  echo "    已有配置，保留现有配置项与 sessionSecret/users（升级模式）"
  cp "$PREFIX/config.json" "$PREFIX/config.json.bak.$(date +%s)"
  export FORCE_PW
  "$NODE_BIN" -e '
    const fs=require("fs"), b=process.argv[1], u=process.argv[2];
    const old=JSON.parse(fs.readFileSync(b,"utf8")), upd=JSON.parse(fs.readFileSync(u,"utf8"));
    if (process.env.FORCE_PW==="1") { delete old.users; delete old.adminPassword; }
    Object.assign(old, upd);
    fs.writeFileSync(b, JSON.stringify(old,null,2));
  ' "$PREFIX/config.json" "$NEW_CFG"
  rm -f "$NEW_CFG"
else
  mv "$NEW_CFG" "$PREFIX/config.json"
fi
chmod 600 "$PREFIX/config.json"

# 直接指定管理员密码(装在面板启动之前写入)
if [ -n "$ADMIN_PASSWORD" ]; then
  echo "==> 3.5/6 设置管理员密码"
  "$NODE_BIN" "$PREFIX/server.js" --set-password "admin" "$ADMIN_PASSWORD"
  _scheme=http; [ "$HTTPS" = "true" ] && _scheme=https
  cat > "$PREFIX/admin-cred.txt" <<EOF
ocserv 管理面板账号
URL:      $_scheme://$HOST:$PORT/
用户名:   admin
密码:     $ADMIN_PASSWORD
改密码:   node $PREFIX/server.js --set-password admin <新密码>
EOF
  chmod 600 "$PREFIX/admin-cred.txt"
fi

echo "==> 4/6 写入 systemd 单元"
cat > /etc/systemd/system/ocserv-panel.service <<EOF
[Unit]
Description=$TITLE
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=$NODE_BIN $PREFIX/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "==> 5/6 启动服务"
systemctl daemon-reload
systemctl enable ocserv-panel >/dev/null 2>&1 || true
systemctl restart ocserv-panel
sleep 3

echo "==> 6/6 结果"
if ! systemctl is-active --quiet ocserv-panel; then
  echo "    启动失败，最近日志:" >&2
  journalctl -u ocserv-panel -n 20 --no-pager -o cat >&2
  exit 1
fi
echo "    服务状态: $(systemctl is-active ocserv-panel)"
echo "    监听:     $(ss -lntp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $4}' | tr '\n' ' ')"
SCHEME=http; [ "$HTTPS" = "true" ] && SCHEME=https
echo "    访问:     $SCHEME://$HOST:$PORT/"
if [ -f "$PREFIX/admin-cred.txt" ]; then
  echo "    ---- 管理员凭据 ----"
  sed 's/^/    /' "$PREFIX/admin-cred.txt"
fi
echo "    完成。"
