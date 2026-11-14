# 容器镜像（Docker）

把 ocserv + 管理面板打成一个镜像，用于**快速试跑 / 演示 / 单机部署**。
镜像内：Ubuntu 24.04 的 `ocserv 1.2.4` + Node 22 LTS + 面板 `1.6.2`。

> 注意：容器里**没有 systemd**。面板依赖 `systemctl` 的功能（服务启停按钮、配置向导第 4 步
> 「应用」、日志页读 journal）在容器内**不可用**；配置由环境变量在启动时生成。
> 需要面板全功能请用主机安装（`install.sh`）。

## 构建

```bash
docker build -t ocserv-deploy-kit:1.6.2 .
```

## 运行

```bash
docker run -d --name ocserv \
  --device /dev/net/tun --cap-add NET_ADMIN \
  -e OC_DOMAIN=vpn.example.com \
  -e OC_PORT=443 \
  -e VPN_USER=alice -e VPN_PASS='换成强密码' \
  -e PANEL_ADMIN_PASSWORD='面板密码' \
  -p 443:443/tcp -p 443:443/udp \
  -p 19999:19999 \
  ocserv-deploy-kit:1.6.2
```

跑完看日志拿面板地址与初始账号：

```bash
docker logs ocserv
docker exec ocserv cat /var/lib/ocserv-panel/admin-cred.txt
```

`/dev/net/tun` 和 `NET_ADMIN` 是给 ocserv 建 tun 设备用的；要做 NAT（客户端经 VPN 上网）
还需要 `NET_ADMIN`（镜像内用 iptables 自己加 MASQUERADE，默认开启，`ENABLE_NAT=0` 关掉）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OC_DOMAIN` | `vpn.example.com` | 证书域名，同时决定 `/etc/ssl/securev/<域名>/` |
| `OC_PORT` | `443` | VPN 端口（tcp+udp 同号） |
| `OC_NET` / `OC_MASK` | `10.66.66.0` / `255.255.255.0` | 客户端网段 |
| `OC_DNS1` / `OC_DNS2` | `1.1.1.1` / `8.8.8.8` | 下发 DNS |
| `VPN_USER` / `VPN_PASS` | — | 首次启动创建的 VPN 用户 |
| `PANEL_PORT` | `19999` | 面板端口 |
| `PANEL_ADMIN_PASSWORD` | 随机 | 面板管理员密码；不给则随机写入 admin-cred.txt |
| `ENABLE_NAT` | `1` | 容器内做 MASQUERADE |
| `OC_OUTIF` | 自动探测 | NAT 出口网卡 |

## 证书

首次启动若 `/etc/ssl/securev/<OC_DOMAIN>/` 下没有 `fullchain.pem` + `privkey.pem`，
会生成 **30 天自签证书**（客户端会报证书不受信任，仅适合联调用）。

用真证书就把目录挂进去，文件名固定这两个：

```bash
-v /etc/ssl/securev/vpn.example.com:/etc/ssl/securev/vpn.example.com:ro
```

DNS-01 签发（acme.sh）在容器里也能跑，但证书与 acme.sh 状态都在容器内，
需要把 `/etc/ssl/securev` 与 `/root/.acme.sh` 都挂出来才有意义；更省事的做法是
在主机上用本项目的 `install.sh` 拿到证书再挂进来。

## 持久化

| 路径 | 内容 |
|---|---|
| `/etc/ocserv` | `ocserv.conf`、`ocpasswd` |
| `/etc/ssl/securev` | 证书 |
| `/var/lib/ocserv-panel` | 面板 `config.json`、`admin-cred.txt`、会话密钥 |
| `/var/log` | 面板/续期相关日志 |

都给的是命名卷或匿名卷，`docker rm` 后数据仍在卷里；`docker run` 带 `-v` 可以把它们落到宿主机目录。

## 已知限制

- 面板「服务状态」显示不准确（读 `systemctl`），**服务控制按钮无效**：重启容器即可
- 配置向导第 2 步签发证书依赖 `systemctl reload`，在容器内会失败；改用环境变量 + 挂证书
- 没有 cron/续期任务（`acme-renew.sh` 需要 systemd 与主机路径）
- 容器内 `ocserv 1.2.4` 与主机安装一致，仍受上游 1.5.0 两项未编号 `[SECURITY]` 修复影响
  （见主 README「ocserv 版本与安全更新」）
