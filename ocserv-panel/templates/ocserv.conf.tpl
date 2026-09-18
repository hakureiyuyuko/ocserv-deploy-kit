# ============================================================================
#  ocserv 配置模板（由面板的「配置向导」生成，占位符会被替换）
#  @CERTDIR@ @VPNPORT@ @VPNNET@ @VPNMASK@ @DOMAIN@ @DNS1@ @DNS2@
# ============================================================================

auth = "plain[passwd=/etc/ocserv/ocpasswd]"

tcp-port = @VPNPORT@
udp-port = @VPNPORT@

run-as-user = ocserv
run-as-group = ocserv
socket-file = /run/ocserv-socket
pid-file = /run/ocserv.pid

server-cert = @CERTDIR@/fullchain.pem
server-key  = @CERTDIR@/privkey.pem

# ---------------------------------------------------------------- 兼容性
# 让 Cisco AnyConnect / 兼容客户端能正常连（面板「选项」页可一键开关）
cisco-client-compat = true
dtls-legacy = true
try-mtu-discovery = true
# 若遇到很老的客户端（只支持 TLS1.0/1.1）连不上，把后面的 -VERS-TLS1.0:-VERS-TLS1.1 去掉
tls-priorities = "NORMAL:%SERVER_PRECEDENCE:%COMPAT:-VERS-SSL3.0:-VERS-TLS1.0:-VERS-TLS1.1"

# ---------------------------------------------------------------- 运行参数
isolate-workers = true
max-clients = 32
max-same-clients = 2
keepalive = 32400
dpd = 90
mobile-dpd = 1800
switch-to-tcp-timeout = 25
auth-timeout = 240
min-reauth-time = 300
max-ban-score = 80
ban-reset-time = 300
cookie-timeout = 300
deny-roaming = false
rekey-time = 172800
rekey-method = ssl
use-occtl = true
log-level = 1
device = vpns
predictable-ips = true
default-domain = @DOMAIN@

# ---------------------------------------------------------------- 客户端网络
# 注意：这个网段必须避开客户端本机已有的网段！
# Windows 上装了 OpenVPN 类软件常会留下 TAP 网卡并静态占用 10.10.10.1/24，别用 10.10.10.0/24
ipv4-network = @VPNNET@
ipv4-netmask = @VPNMASK@
mtu = 1420

dns = @DNS1@
dns = @DNS2@
tunnel-all-dns = true

# 全局代理；只让内网走 VPN 的话把这行注释掉，改成具体网段 route = 192.168.0.0/16
route = default
ping-leases = false
