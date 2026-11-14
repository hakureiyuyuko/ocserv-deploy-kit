# syntax=docker/dockerfile:1
# ============================================================================
#  ocserv-deploy-kit 容器镜像
#    ocserv（Ubuntu 24.04 仓库版本）+ 管理面板（Node 22 LTS 运行时）
#  构建:  docker build -t ocserv-deploy-kit:1.6.2 .
#  说明:  docker/README.md
# ============================================================================

# Node 22 LTS 的官方静态二进制；Ubuntu 24.04 自带的 nodejs 是 18（已 EOL）
FROM node:22-bookworm-slim AS nodebin

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ocserv 1.2.4（与主机安装一致）；socat 供面板部分功能用；iptables 用于容器内 NAT
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ocserv socat curl openssl ca-certificates iptables iproute2 libstdc++6 procps \
 && rm -rf /var/lib/apt/lists/*

# ocserv 包自带的示例 /etc/ocserv/ocserv.conf 没有证书路径，删掉让 entrypoint 生成
RUN rm -f /etc/ocserv/ocserv.conf

# 从 node:22 镜像里只取 node 二进制（动态链接，ubuntu 24.04 的 glibc 兼容）
COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node

COPY ocserv-panel/ /opt/ocserv-panel/
COPY docker/entrypoint.sh /usr/local/bin/ocserv-entrypoint.sh

# 面板把 config.json / admin-cred.txt 写在自身目录里；软链到卷，重建容器不丢
RUN chmod 755 /usr/local/bin/ocserv-entrypoint.sh \
 && mkdir -p /etc/ocserv /etc/ssl/securev /var/lib/ocserv-panel /var/log \
 && chmod 700 /etc/ssl/securev \
 && ln -sf /var/lib/ocserv-panel/config.json   /opt/ocserv-panel/config.json \
 && ln -sf /var/lib/ocserv-panel/admin-cred.txt /opt/ocserv-panel/admin-cred.txt \
 && node -v && ocserv --version 2>&1 | head -1

EXPOSE 443/tcp 443/udp 19999/tcp

VOLUME ["/etc/ocserv", "/etc/ssl/securev", "/var/lib/ocserv-panel", "/var/log"]

# 只用 exec 形式，信号直达 entrypoint；由 entrypoint 负责转发给子进程
ENTRYPOINT ["/usr/local/bin/ocserv-entrypoint.sh"]
