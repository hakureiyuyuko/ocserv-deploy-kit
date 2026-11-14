# Alpine 一键包

Alpine 用的独立发行包：**ocserv 二进制、依赖库、Node 运行时、面板、OpenRC 服务**全在包里，
目标机不需要从仓库拉 ocserv（Alpine 稳定仓库没有这个包）。

## 为什么单独发一个包

| 问题 | 说明 |
|---|---|
| 仓库里没有 ocserv | 官方 `v3.18 ~ v3.24` 都没有 `ocserv` 包，只有 `edge` 有 1.6.0，且 edge 的依赖在稳定版上装不上 |
| 没有 systemd | 本套件原本按 systemd 写；1.6.3 起面板的服务控制抽成 systemd / OpenRC 双后端 |
| 需要 musl 二进制 | glibc 的二进制在 Alpine 上跑不了，所以这里是 **Alpine 3.24 + musl 现场编译**的 |

## 包内容

```
install.sh / uninstall.sh     安装、卸载
VERSION                       版本号
bin/ocserv  bin/node          自编译二进制（ocserv 1.6.0 / Node 24）
lib/                          两者的依赖库（gnutls、nettle、pam、oath… 与 libstdc++）
ocserv-panel/                 管理面板（1.6.3）
openrc/ocserv, ocserv-panel   OpenRC 服务脚本
```

形态：x86_64 / musl，安装到 `/opt/ocserv-deploy-kit`（二进制+库）与 `/opt/ocserv-panel`（面板）。

## 安装

```sh
tar xzf ocserv-deploy-kit-alpine-x86_64-1.6.3.tar.gz
cd ocserv-deploy-kit-alpine-x86_64-1.6.3
sudo ./install.sh                       # 可选 --panel-port，--admin-password
```

装完面板在 `http://<本机IP>:19999/`，初始账号密码见 `/opt/ocserv-panel/admin-cred.txt`。
接下来在面板「配置向导」里填域名 / 证书 / 用户，第 4 步会生成 `ocserv.conf`、
装 NAT 的 OpenRC 服务并启动 ocserv。

## 依赖与前提

- 架构 **x86_64**（其它架构需另行编译）
- 内核要有 tun：`ls /dev/net/tun`；LXC/容器里要放行并映射该设备
- 防火墙/安全组放行 VPN 端口 **TCP + UDP**
- 面板端口默认只应开给内网

## 已知限制

- **自动续期未安装**：面板在 OpenRC 环境下会提示跳过（acme.sh 需要联网，且续期脚本原本按
  systemd 写）。证书请用「上传已有证书」，或装好 acme.sh 后手动在「证书」页续期。
- 面板自身改端口会重启进程，OpenRC 的监督可能把它记为 stopped；改完执行一次
  `rc-service ocserv-panel restart` 即可。
- ocserv 版本为 1.6.0（比 Ubuntu 24.04 的 1.2.4 新，已含上游 1.5.0 的两项 `[SECURITY]` 修复）。

## 与本套件其它部分的关系

配置模板、面板代码与主线完全一致；区别只在"谁来托管进程"（OpenRC）和"二进制从哪来"（随包）。
Debian/Ubuntu 仍然用 `install.sh`（apt + systemd），不受影响。
