# ocserv 部署套件

一键装好 **ocserv（OpenConnect / Cisco AnyConnect 兼容 VPN）+ Web 管理面板**。
安装脚本只负责装，域名、证书、VPN 用户、网段都在面板里配置。

支持 Ubuntu / Debian（systemd）。

> **先看效果**：面板有[在线演示](https://hakureiyuyuko.github.io/ocserv-deploy-kit/)
> （GitHub Pages，纯前端 mock，无需安装，数据全是虚构示例）。

---

## 快速开始

### 1. 安装

```bash
tar xzf ocserv-deploy-kit-*.tar.gz
cd ocserv-deploy-kit
sudo ./install.sh --panel-port 19999 --admin-password '你的面板密码'
```

| 参数 | 说明 |
|---|---|
| `--panel-port N` | 面板端口，默认 `19999` |
| `--admin-password PW` | 面板管理员密码；不填则随机生成并打印 |
| `--panel-host IP` | 面板监听地址，默认 `0.0.0.0`；只让内网访问就填内网 IP |
| `--panel-title TXT` | 面板标题 |
| `--no-node` | 不自动安装 Node.js（已自备 >= 18 时） |

安装脚本只做四件事：装依赖 → 装面板 → 停用 ocserv（等配置）→ 打印面板地址。
不会碰域名、证书、VPN 用户和网段。

### 2. 在面板里配置

打开 `http://<机器IP>:19999` 登录后进入「配置向导」：

1. **基础** — 域名、VPN 端口（默认 443）、客户端网段（默认 `10.66.66.0/24`）、下发 DNS、出口网卡
2. **证书** — DNS-01 / HTTP-01 / 上传已有证书 / 自签（仅测试）
3. **第一个 VPN 用户**
4. **应用** — 写 ocserv.conf → 装证书 → 建用户 → 配 NAT 转发 → 装续期任务 → 启动 ocserv

每一步都有日志回显，失败会说明卡在哪里。

### 3. 更新与卸载

```bash
sudo ./update.sh              # 升级面板到本套件版本（默认静默，成功只打一行）
sudo ./update.sh --help       # 看能透传哪些参数（如 --admin-password 顺便改面板密码）
sudo ./uninstall.sh           # 卸载；默认保留 ocserv 配置 / VPN 用户 / 证书 / acme 账号
sudo ./uninstall.sh --purge   # 连配置、证书、acme.sh 账号一起删（不可恢复）
```

- `update.sh` 只替换**面板程序、模块、模板与 systemd 单元**，不碰 ocserv 配置 / 证书 /
  VPN 用户 / 网段 / 续期任务，也不重装依赖包，所以不会踢掉正在连接的 VPN 用户。
  它还会从 systemd 单元里认出安装目录，已是最新版本时直接告诉你不用更新。
- 升级/重装时**只有命令行显式给的参数才会覆盖**，其余配置（含向导里填的域名、证书路径、
  网段、面板标题、管理员密码）全部沿用，不再被恢复成默认值。
- `uninstall.sh` 默认会交互确认（删除范围列给你看）；脚本或非 tty 环境请加 `--yes`。

---

## 目录结构

```
install.sh          安装入口（只装，不配业务）
update.sh           更新面板（默认静默；只换面板程序，不碰配置/证书/用户）
uninstall.sh        卸载（默认保留配置与证书，--purge 才清干净）
ocserv-panel/       管理面板（Node >= 18，零第三方依赖）
acme/               acme.sh 客户端 + 签发/续期脚本（单独使用时用）
ocserv/             ocserv.conf 模板与 NAT 单元样板
docs/               面板在线演示页（GitHub Pages 用，安装时不需要）
tools/              演示页生成器（node tools/make-demo.mjs）
```

---

## 证书

| 方式 | 需要什么 | 能否自动续期 |
|---|---|---|
| **DNS-01**（推荐） | 域名服务商的 API 凭据 | 能 |
| HTTP-01 | 公网可访问本机 80 端口 | 能 |
| 上传已有证书 | — | 不能（除非之后用上面两种方式签一次） |
| 自签 | — | 不需要（仅测试，客户端会报证书不受信任） |

DNS-01 内置 Cloudflare、阿里云、DNSPod、GoDaddy、DigitalOcean，其它服务商可在「额外变量」里按
`KEY=VALUE` 填。凭据存放于 `/etc/ocserv/acme-dns.env`（权限 600），续期任务会自动加载。

---

## 面板功能

概览（服务状态 / 监听端口 / 证书剩余 / 用户数 / 在线会话 / 系统负载，含服务启停）、
配置向导、用户管理、在线会话、选项（AnyConnect 兼容等开关）、日志、配置编辑、
证书（详情 / 下次续期 / 手动续期 / 续期日志）、面板设置（改面板管理员密码 / 面板端口）。

详见 `ocserv-panel/README.md`。

---

## 在线演示（GitHub Pages）

`docs/` 是一个**纯静态**的面板演示页：把真实前端拿来，前面插一层本地 mock 接口
（`tools/demo-mock.js`），所以点任何按钮都不会碰到服务器，数据全是虚构示例；
域名填错、缺 DNS 凭据、端口被占用、密码错误这些**错误路径也照真实后端的行为还原**。

- 在线地址：https://hakureiyuyuko.github.io/ocserv-deploy-kit/
- 自己重新生成（改了面板后同步演示）：`node tools/make-demo.mjs`
- 部署：仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/docs`

生产环境安装**不需要** `docs/` 与 `tools/`，发布包（`ocserv-deploy-kit-*.tar.gz`）里也不包含它们。

---

## 注意事项

- **面板端口不要对公网开放**，绑内网 IP 或隧道 IP 即可。
- **VPN 客户端网段要和客户端本机网段岔开**（默认 `10.66.66.0/24`）。Windows 上装了 OpenVPN 类软件
  常会留下 TAP 网卡并占用 `10.10.10.0/24`。
- **网关做了端口翻译时 DTLS 会失败**：ocserv 会在 CONNECT 响应里宣告 `X-DTLS-Port`（等于本机 udp-port），
  客户端按它发 UDP。要么端到端用同一个端口（不做翻译），要么额外放行 `UDP <本机端口>`。
  DTLS 不通不影响使用（客户端自动降级到 TCP），只是性能差一些。
- 云服务器安全组需放行 VPN 端口（**TCP + UDP**）。
- 在面板「面板设置」里改过面板端口后，记得同步改路由器/安全组的端口映射，并用新地址访问。

---

## 排查

- 面板 → 日志页看 `journalctl -u ocserv`；证书页看续期日志 `/var/log/acme-renew.log`。
- **不装客户端也能自检服务端**（最后一步返回 `<auth id="success">` 即正常）：

```bash
B=https://<域名>:<端口>
J="-sk -c /tmp/c -b /tmp/c -H 'Content-Type: application/x-www-form-urlencoded' -H 'X-Aggregate-Auth: 1'"
X='<?xml version="1.0" encoding="UTF-8"?>'
rm -f /tmp/c
curl $J -X POST $B/     --data "$X<config-auth client=\"vpn\" type=\"init\"><version who=\"vpn\">4.10.04071</version><capabilities><auth-method>single-sign-on-v2</auth-method></capabilities></config-auth>"
curl $J -X POST $B/auth --data "$X<config-auth client=\"vpn\" type=\"auth-reply\"><version who=\"vpn\">4.10.04071</version><auth><username>vpnuser</username></auth></config-auth>"
curl $J -X POST $B/auth --data "$X<config-auth client=\"vpn\" type=\"auth-reply\"><version who=\"vpn\">4.10.04071</version><auth><username>vpnuser</username><password>密码</password></auth></config-auth>"
```

  > init 里必须带 `<capabilities><auth-method>single-sign-on-v2</auth-method></capabilities>`，
  > 否则 ocserv 不会把后续 `auth-reply` 当成同一会话的下一步（表现为一直问用户名，像认证失败）。
  > 也可以直接装 openconnect 测：
  > `echo '密码' | openconnect --protocol=anyconnect --user=vpnuser --passwd-on-stdin --authenticate <域名>:<端口>`

- 连接异常时先排除域名被按 SNI 拦截（部分机房会拦特定域名）：
  `openssl s_client -connect <IP>:<端口> -servername <你的域名>` 与
  `openssl s_client -connect <IP>:<端口> -servername www.baidu.com` 对比，只有前者失败就是被拦了。

---

## 迁移到新机器

1. 面板 `config.json`、`/etc/ocserv/ocpasswd`（VPN 用户）、`/root/.acme.sh`（证书、账号与凭据）
   可以直接拷到新机器。
2. 把 `/root/.acme.sh` 放回后，在新面板向导里走到「证书」那步会提示证书仍有效、跳过签发，只做安装 ——
   这样不会重复申请证书（同一组域名每周有 5 张的签发上限）。

---

## 许可

- `acme/acme.sh` 是上游 [acmesh-official/acme.sh](https://github.com/acmesh-official/acme.sh)
  的**原样拷贝（未做任何修改）**，版本 `3.1.5`，采用 **GNU GPL v3**，许可证全文见 `acme/LICENSE.md`。
  校验值：`sha256 B81542B4A05EFA88638C727FF7185A44D996A3840C0E7D15B2200B8628301B51`。
- 其余脚本与 `ocserv-panel/` 为本项目原创代码。面板是以**独立进程**调用 `acme.sh` 的
  （exec，不链接、不修改），所以上游的 copyleft 不影响这些文件。

---

## 授权与第三方

- 本套件（安装 / 更新 / 卸载脚本、管理面板及其前端）以 **GNU AGPL-3.0-or-later** 发布，
  全文见 [`LICENSE`](LICENSE)。注意 AGPL 第 13 条：如果你**修改**了本面板并作为网络服务对外提供，
  需要向使用者提供对应源码。
- `acme/acme.sh` 是 [acmesh-official/acme.sh](https://github.com/acmesh-official/acme.sh) 的
  上游原版（未做任何修改），按它自己的 **GNU GPL-3.0** 分发，全文见 [`acme/LICENSE.md`](acme/LICENSE.md)。
  两者属聚合分发（各自独立程序），各自保留自己的许可证。
- 打包不含任何证书、密钥、口令或 API 凭据；这些都在部署时由你本机生成。

---

## 更新日志

- **1.5.0** —— 新增 `update.sh`（静默更新：只换面板程序与 systemd 单元，不碰 ocserv 配置/证书/
  用户/续期任务）与套件级 `uninstall.sh`（默认保留配置与证书，`--purge` 连数据一起清，`--yes`
  供脚本调用）。同时修掉「重跑安装脚本会把向导写的域名/证书路径/网段/标题覆盖回默认值」的 bug：
  升级时只有**显式传入**的参数才覆盖，其余全沿用；`ocserv-panel/install.sh` 也不再依赖当前工作目录。
  另外仓库增加 **GitHub Pages 在线演示**（`docs/` + `tools/make-demo.mjs`），不进安装包。
  另外把上游 acme.sh 的许可证全文补进 `acme/LICENSE.md`。
- **1.4.0** —— 面板新增**「面板设置」页**：改管理员密码（立即生效）、改面板监听端口（改完自动重启面板；
  改密码/端口都需输入当前密码，端口会先试监听，占用则不落盘）。安装脚本本身不变。
- **1.3.1** —— 面向对外发布整理：移除内部排障记录，精简脚本输出与文档。
- **1.3.0** —— 安装与配置分离：`install.sh` 只装（面板端口 + 管理员密码）；
  域名、证书、VPN 用户、网段改为在面板「配置向导」里配置。
- **1.2.3** —— 新增 `--cert-dir` / `--acme-home`：用本地已有证书部署，不联系 Let's Encrypt。
- **1.2.2** —— 新增 DNS-01 验证；修正 `set -e` 与 acme.sh 退出码冲突。
- **1.2.1** —— 修复安装脚本自身的两个问题。
- **1.2.0** —— 首个套件版本。
