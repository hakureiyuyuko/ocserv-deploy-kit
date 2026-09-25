# ocserv 管理面板

一个**零第三方依赖**的 ocserv(OpenConnect VPN) Web 管理面板。单个 Node.js 文件 + 一个静态页，
不需要 `npm install`，不拉任何依赖包，适合往各种 Linux 服务器上丢。
带**日间/夜间模式**（默认日间，浅色高对比，老显示器/低 DPI 屏看着更清楚）。

```
ocserv-panel/
├── server.js              # 后端(零依赖, 仅用 Node 内置模块)
├── public/index.html      # 前端(原生 JS, 无构建)
├── lib/tpl.js             # 纯函数: 模板渲染 / 网段换算 / systemd 单元生成
├── templates/             # 配置向导用模板
│   ├── ocserv.conf.tpl        # ocserv 配置(占位符由向导替换)
│   └── acme-renew.sh.tpl      # 续期脚本
├── install.sh             # 安装(含 systemd 单元生成)
├── uninstall.sh           # 卸载
└── README.md
```

许可证：**AGPL-3.0-or-later**（全文见上级目录的 `LICENSE`）。

---

## 功能

右上角可切换**日间/夜间模式**（存在浏览器 localStorage，默认日间）。

| 页面 | 能力 |
|---|---|
| **配置向导** | **首次初始化四步**：① 域名/VPN 端口/客户端网段/DNS/出口网卡 ② 证书(DNS-01 / HTTP-01 / 上传 / 自签) ③ 第一个 VPN 用户 ④ 应用(写 conf → 装证书 → 建用户 → 装 NAT 单元 → 装续期 cron → enable+启动 ocserv)。未初始化时概览页会提示入口 |
| 概览 | 服务状态/PID/重启次数、监听端口、证书剩余天数、用户数、在线会话数、系统负载与内存 |
| 服务控制 | 启动 / 重启 / **重载(不断线)** / 停止 |
| 选项 | **开关式**修改常见布尔选项（AnyConnect 兼容、旧版 DTLS、MTU 发现、DNS 走隧道……），自动备份+校验+回滚 |
| 用户管理 | 列出、新增、删除、重置密码（直接操作 `ocpasswd`，立即生效，无需重启） |
| 在线会话 | `occtl` 会话列表（优先 JSON，自动降级文本解析） |
| 日志 | `journalctl` 实时查看，支持自动刷新 |
| 配置 | 在线编辑 `ocserv.conf`：**保存前备份 → `--test-config` 校验 → 失败自动回滚** → 成功才 reload |
| 证书 | 证书主题/签发者/SAN/到期时间/剩余天数、下次续期时间、一键「检查续期」「强制续期」、续期日志 |
| **面板设置** | 改**面板管理员密码**（需当前密码，保存后立即生效、无需重启，并同步 `admin-cred.txt`）、改**面板监听端口**（先探测端口能否监听 → 写 `config.json` → 自动重启面板；失败不落盘） |

## 环境要求

- Linux + systemd，root 权限（要写 `ocpasswd`、控 systemd）
- **Node.js >= 18**（脚本会尝试用 apt 自动装）
- 已安装 ocserv（`apt install ocserv`）

## 功能开关（“选项”页）

面板把几个常改的 ocserv 布尔项做成了开关，不用去翻配置文件：

| 键 | 说明 |
|---|---|
| `cisco-client-compat` | **AnyConnect 兼容模式**：让 Cisco AnyConnect / 兼容客户端能正常连 |
| `dtls-legacy` | 兼容旧版 DTLS 协商 |
| `try-mtu-discovery` | MTU 自动发现（建议保持开） |
| `tunnel-all-dns` | DNS 全部走隧道 |
| `deny-roaming` | 禁止漫游（换网络即断开） |
| `ping-leases` | 下发地址前 ping 探测 |

行为：写回 `ocserv.conf` → 自动备份（`ocserv.conf.bak-<ts>`）→ `--test-config` 校验 →
**失败自动回滚** → 成功 `systemctl reload` 热重载（不断线）。已经是目标值时不会重复写（返回 `changed:false`）。
只接受白名单里的键（改不了端口之类的敏感项）。

想加新开关：编辑 `server.js` 顶部的 `OPTION_KEYS` 对象加一行即可（label/desc/def），前端自动渲染。

> 热重载对绝大多数选项够用；个别选项（如涉及监听/工作进程的）可能需要重启服务才完全生效。

## 安装

```bash
tar -xzf ocserv-panel-*.tar.gz
cd ocserv-panel
sudo ./install.sh --host 10.0.0.1 --port 19999 --admin-password '你的面板密码'
```

> 用套件（`ocserv-deploy-kit`）时不用单独装它 —— 套件的 `sudo ./install.sh --panel-port ... --admin-password ...`
> 会带上 `lib/` 与 `templates/` 一起装好，然后你在界面的「配置向导」里配域名/证书/用户。
> 不上套件、只用面板也可以：手动传 `--acme-domain` 让证书页有默认域名。

装完终端会直接打印管理员账号密码（也存于 `<prefix>/admin-cred.txt`，权限 600）。

### 常用参数

| 参数 | 说明 |
|---|---|
| `--host IP` | 监听地址。**只走 WireGuard / 内网时填隧道 IP**（如 `10.0.0.1`），公网侧就完全不会暴露 |
| `--port N` | 监听端口，默认 `19999` |
| `--https` | 启用 HTTPS（需 `--cert`/`--key`）。**内网访问没必要**：按 IP 访问会因证书名不匹配报警告，而隧道本身already加密 |
| `--title "文字"` | 面板标题 |
| `--acme-domain D` | ACME 域名，用来自动推导证书路径并展示续期信息 |
| `--ocserv-conf` / `--ocpasswd` / `--ocserv-service` | 非默认路径/服务名时用 |
| `--reset-password` | 重装时重置管理员密码 |

完整列表：`./install.sh --help`

### 升级

重复执行 `install.sh` 即可（不需要先 `cd` 进目录，脚本会按自己的位置找源码）。脚本会**保留**
`config.json` 里所有**没在命令行显式给出**的配置项（包括向导填的 `acmeDomain` / `certFile` /
`keyFile` / `vpnNet`、面板标题 / 端口 / 监听地址）以及 `sessionSecret` 和 `users`，
只覆盖你这次显式传入的参数，并自动备份旧配置。

只想升级面板程序、不动其它东西，用套件根的 `sudo ./update.sh`（默认静默）。

## 使用

```bash
# 访问
http://10.0.0.1:19999/

# 常用运维
systemctl status ocserv-panel
journalctl -u ocserv-panel -f

# 改管理员密码 / 改监听端口 -> 面板「面板设置」页（推荐，改密码立即生效）
# 命令行兜底（注意: 面板正在运行时改密码需重启才生效）
node /opt/ocserv-panel/server.js --set-password admin '新密码'
systemctl restart ocserv-panel

# 命令行兜底：改监听地址/HTTPS 开关等只能编辑 config.json 后重启
vi /opt/ocserv-panel/config.json && systemctl restart ocserv-panel

# 忘了管理员密码 -> 见下方「忘了管理员密码怎么办」

# 卸载
sudo ./uninstall.sh
```

### 忘了管理员密码怎么办

面板**故意没有**“网页上重置密码”的入口 —— 那等于任何能访问面板端口的人都能接管管理员账号，
信任锚点必须是那台机器的 root。所以恢复只有一条主线：**SSH 上去，用 root 重置**。

```bash
# 1) 先看一眼：安装 / 面板改密码 / CLI 改密码，都会把当前密码同步写到这个文件（权限 600）
sudo cat /opt/ocserv-panel/admin-cred.txt

# 2) 确定要重置（不用停服务）
sudo node /opt/ocserv-panel/server.js --set-password admin '新密码'
sudo systemctl restart ocserv-panel          # 必须重启：面板只在启动时读 config.json

# 3) node 不在 root 的 PATH 里（nvm/snap 装的）时，用 systemd 单元里记的绝对路径
NODEBIN=$(systemctl show ocserv-panel -p ExecStart --value | sed 's/.*path=\([^ ]*\).*/\1/')
sudo "$NODEBIN" /opt/ocserv-panel/server.js --set-password admin '新密码'
sudo systemctl restart ocserv-panel
```

- 装到别的目录：`systemctl show ocserv-panel -p WorkingDirectory --value`
- 想顺便升级面板：`cd ocserv-panel && sudo ./install.sh --reset-password --admin-password '新密码'`
- **不要**拿套件根目录的 `install.sh` 做这件事：它是首次安装入口，会 `apt-get` 装依赖并
  `systemctl disable --now ocserv`，**把正在用的 VPN 停掉**。
- `--set-password` 给的用户名如果不存在，会**新建一个登录账号** —— 别敲错用户名。
- 用户名忘了：面板只有一个内置账号 `admin`（`config.json` 的 `users` 里能看到全部）。
- 完全没有 SSH/root 权限：只能重装 —— 这正是“不提供网页重置”的代价，也是它的目的。
- `admin-cred.txt` 存的是**明文**密码，保持 600；不想留就 `sudo rm` 掉（以后再改密码会重新生成）。

> 注意：面板**正在运行时**用命令行改了密码，必须 `systemctl restart ocserv-panel` 才生效；
> 在网页「面板设置」里改则立即生效。

## 配置项（`<prefix>/config.json`）

```jsonc
{
  "title": "ocserv 管理面板",
  "host": "0.0.0.0",           // 监听地址
  "port": 19999,
  "https": false,              // true 时才需要 certFile/keyFile
  "certFile": "/etc/ssl/securev/ssl.example.com/fullchain.pem",
  "keyFile":  "/etc/ssl/securev/ssl.example.com/privkey.pem",
  "ocservConf": "/etc/ocserv/ocserv.conf",
  "ocpasswd":   "/etc/ocserv/ocpasswd",
  "ocservBin":  "/usr/sbin/ocserv",
  "ocservService": "ocserv",
  "acmeDomain": "ssl.example.com",     // 仅用于证书页展示
  "acmeBin": "/root/.acme.sh/acme.sh",
  "acmeServer": "https://acme-v02.api.letsencrypt.org/directory",
  "renewScript": "/usr/local/bin/acme-renew.sh",
  "renewLog": "/var/log/acme-renew.log",
  "sessionSecret": "…自动生成,勿泄露…",
  "users": { "admin": { "salt": "…", "hash": "…" } }
}
```

## 安全设计

- 密码用 **scrypt** 加盐哈希存储（`config.json` 权限 600）
- 会话 Cookie：`HttpOnly` + `SameSite=Strict`（TLS 时自动加 `Secure`），12 小时过期
- **CSRF 防护**：所有 POST 必须带 `x-panel: 1` 自定义头，并校验同源——跨站请求无法伪造自定义头而不触发 CORS 预检
- 登录失败 5 次锁定该 IP 10 分钟
- 无未授权接口（除 `/api/meta` 只返回标题版本号）
- 改密码 / 改端口都需**重新输入当前密码**（防会话被劫持后直接接管），新密码至少 6 位且不得与旧密码相同
- 忘记密码**只能在那台机器上（root）重置**：面板没有任何“网页找回”入口，否则任何能访问端口的人都能接管
- 绑定内网/隧道地址时公网无监听，无需动云安全组

> 提示：明文 HTTP 下的登录密码靠传输层（WireGuard/内网）保护。如果面板要暴露到公网，
> 请开 `https=true` 或放在反代之后。

## 配套：证书自动续期

面板的「证书」页依赖一个续期脚本（默认 `/usr/local/bin/acme-renew.sh`）。
**用配置向导时它会自动装好**；手工装的话用 `templates/acme-renew.sh.tpl`：

```bash
install -m 755 templates/acme-renew.sh.tpl /usr/local/bin/acme-renew.sh
sed -i -e 's/@DOMAIN@/你的域名/' -e 's/@OCSERV_SERVICE@/ocserv/' -e 's/@PANEL_SERVICE@/ocserv-panel/' \
  /usr/local/bin/acme-renew.sh
( crontab -l 2>/dev/null | grep -v acme-renew; echo '30 3 * * * /usr/local/bin/acme-renew.sh' ) | crontab -
```

续期成功后它会**热重载** ocserv（`SIGHUP` 重读证书，不断开在线用户）。
签发证书（本机无 web 服务时用 standalone，会临时占用 80 端口做 HTTP-01；
配了 DNS-01 则换成 `--dns dns_xxx`）：

```bash
/root/.acme.sh/acme.sh --issue --standalone -d 你的域名 --keylength ec-256
/root/.acme.sh/acme.sh --install-cert -d 你的域名 \
  --key-file /etc/ssl/securev/你的域名/privkey.pem \
  --fullchain-file /etc/ssl/securev/你的域名/fullchain.pem \
  --reloadcmd "systemctl reload ocserv"
```

## 踩坑备忘（都是实测踩过的）

1. **ocpasswd 行格式是 `用户名:组:哈希`**（无组时组为 `*`），不是 `用户名:哈希:组`。按后者解析会把哈希显示成"组"。
2. **`ocserv --version` 输出到 stderr**，只读 stdout 会拿到空字符串。
3. **改 `tcp-port`/`udp-port` 必须 `systemctl restart`**：`reload`(SIGHUP) 只重读证书和 CRL，不会重绑端口。
4. **写 ocpasswd 要喂两次密码**：`printf '%s\n%s\n' "$pw" "$pw" | ocpasswd -c <file> <user>`（无 tty 时 `getpass` 从 stdin 读）。
5. **`occtl -j show users` 无用户时返回 `[]`**，是合法 JSON，别当成解析失败。
6. 面板按 IP 访问时用 HTTPS 会报证书名不匹配 —— 内网直接用 HTTP 更省事。
7. ocserv 配置里 `server-stats-reset-on-server-start` 在 1.2.x 是**未知选项**，会打 warning，可删。
8. **VPN 网段（`ipv4-network`）一定要避开客户端本机已有的网段**！典型撞车：机器上装过 OpenVPN/其他 VPN 会留下 TAP 虚拟网卡
   （Windows 里叫 "TAP-Windows Adapter V9"，别名可能像 `KSA Host Adapter`），它上面往往静态配着 `10.10.10.1/24`。
   如果你把 ocserv 的 `ipv4-network` 也设成 `10.10.10.0/24`，AnyConnect 客户端拿到同网段地址后路由冲突，
   表现就是**连不上/通信错误**（且不论公网还是隧道都一样失败，很容易误判成服务端问题）。
   选网段前先在客户端 `Get-NetIPAddress -AddressFamily IPv4` 看一眼，或直接用少见网段（如 `10.66.66.0/24`）。
9. 改完 `ipv4-network` **别忘了同步改 NAT**（`ocserv-nat.service` 与 iptables 里的 masquerade/FORWARD 网段），否则客户端连上也不通外网。
10. 验证服务端 AnyConnect 协议是否正常，不用装客户端：用 curl 手工跑三步 XML 交互（`type=init` → `auth-reply` 带用户名 → `auth-reply` 带密码），
    最后应返回 `type="complete"`，那就说明证书/协议/认证都没问题，故障在客户端或链路。
11. `.box h2` 上有 `text-transform:uppercase`，里面的 `.muted` 小字要显式 `text-transform:none`，否则
   `ocserv.conf` 会被显示成 `OCSERV.CONF`。
12. 卡片里的值不要用 `word-break:break-all`，否则 `4443` 会被从中间拆行（应合并显示为 `TCP/UDP 4443`）。
13. 按钮里别依赖 emoji 字符（🌙 之类在部分 Windows/老显示器上会渲染成怪符号），用纯文字最稳。
14. **面板由 systemd 启动时环境里没有 `HOME`**，而 acme.sh 的工作目录是 `$HOME/.acme.sh`；
   缺了 `HOME` 它会去用 `/.acme.sh`（空目录），于是丢掉已注册账号与凭据、回落到内置默认 CA（ZeroSSL）。
   给子进程补上 `HOME` / `PATH`，并给 `--issue` 显式带 `--server` 最稳。
15. **`acme.sh --install-cert` 不会自建目标目录**：目录不存在时它直接返回 1。
   写证书前先 `mkdir -p /etc/ssl/securev/<域名>`；另外它返回非 0 不一定是失败
   （证书已写好、只是 reloadcmd 失败时也会返回非 0），判据应该是文件写没写。

## 更新日志

- **1.5.0** —— 升级不再丢向导写的配置：重跑 `install.sh` 时只有**显式传入**的参数才覆盖，
  `acmeDomain` / `certFile` / `keyFile` / `vpnNet` / 标题 / 端口 / 监听地址都沿用旧值
  （之前会被恢复成默认值，导致证书页空白、HTTPS 回落 HTTP）。另外脚本不再依赖
  当前工作目录（从任意目录都能跑），并可配合套件根的 `update.sh` 静默升级。
- **1.4.0** —— 新增**「面板设置」页**：改面板管理员密码（立即生效，不需重启）、改面板监听端口
  （写盘前先探测端口能否监听，改完自动重启面板，不依赖 systemd 的 Restart=always 的部署也能自行拉起）；
  接口 `GET /api/panel`、`POST /api/panel/password`、`POST /api/panel/port`。
  顺带修：`admin-cred.txt` 里“改密码”提示补上“面板运行时需 restart 才生效”，`--set-password` 同样提示。
  文档补充：新增「忘了管理员密码怎么办」标准流程（读 `admin-cred.txt` / CLI 重置 + 重启 / 重跑安装脚本，
  以及“别用套件根 install.sh”与“没有网页重置入口”的原因）。
- **1.3.1** —— 面向对外发布整理：移除内部排障记录与示例里的真实 IP/域名，精简输出与文档。
- **1.3.0** —— 新增**配置向导**（域名 / 证书 / VPN 参数 / 第一个用户 / NAT 单元 / 续期 / 启动 ocserv 都在面板里完成）；
  安装与其分离：`install.sh` 新增 `--admin-password`，并安装 `lib/` 与 `templates/`；
  新增 `/api/setup`、`/api/setup/cert`、`/api/setup/apply` 三个接口。
  修两个只有真机才暴露的坑（见下方备忘第 14、15 条）。
- **1.2.0** —— 从实际部署里回收的经验：新增“服务端 AnyConnect 协议自检”章节（curl 三步 XML）、
  补录“域名被 SNI 封锁”与“VPN 网段撞车”两条大坑；默认 CA 改为 Let's Encrypt。
- **1.1.0** —— 新增“选项”页开关（含 AnyConnect 兼容一键开关）；新增日间/夜间模式（默认日间）；
  修复 `ocserv.conf` 被强制大写、监听端口数字被折行等排版问题。
- 1.0.0 —— 首次发布：概览/用户/会话/日志/配置/证书 + 一键安装。
