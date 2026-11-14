#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================================
#  构建 Alpine 发行包（主机侧入口；CI 与本地共用）
#
#  用法:
#    bash alpine/build-package.sh --version 1.6.3 [--out dist]
#                                  [--arch x86_64|aarch64]
#                                  [--alpine 3.24] [--ocserv 1.6.0]
#
#  说明:
#    · 一切编译都在 alpine:<版本> 容器里做，主机只需要 docker
#    · 本机若需要 sudo 调 docker：sudo bash alpine/build-package.sh ...
#    · aarch64 需要主机能跑 arm64 容器（CI 用 setup-qemu，本地 binfmt 已装即可）
# ============================================================================
set -euo pipefail

VERSION=""
OUT="$PWD/dist"
ALPINE_VER="3.24"
OCSERV_VERSION="1.6.0"
ARCH="x86_64"
DOCKER="${DOCKER:-docker}"

usage() {
  sed -n '5,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2;;
    --out)     OUT="$2"; shift 2;;
    --alpine)  ALPINE_VER="$2"; shift 2;;
    --ocserv)  OCSERV_VERSION="$2"; shift 2;;
    --arch)    ARCH="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "未知参数: $1" >&2; usage; exit 1;;
  esac
done

[ -n "$VERSION" ] || { echo "缺少 --version" >&2; usage; exit 1; }
case "$ARCH" in
  x86_64)  PLATFORM="linux/amd64";;
  aarch64) PLATFORM="linux/arm64";;
  *) echo "不支持的架构: $ARCH（x86_64 / aarch64）" >&2; exit 1;;
esac

REPO=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

command -v "$DOCKER" >/dev/null 2>&1 || { echo "找不到 $DOCKER（可用 DOCKER=... 指定）" >&2; exit 1; }

echo "==> 镜像 alpine:${ALPINE_VER}（${PLATFORM}），ocserv ${OCSERV_VERSION}，版本 ${VERSION}"
$DOCKER run --rm --platform "$PLATFORM" \
  -e VERSION="$VERSION" \
  -e OCSERV_VERSION="$OCSERV_VERSION" \
  -e ARCH="$ARCH" \
  -v "$REPO:/src:ro" \
  -v "$OUT:/out" \
  "alpine:${ALPINE_VER}" sh /src/alpine/ci-build-in-container.sh

# 容器以 root 写入，交还给当前用户
if [ "$(id -u)" != "0" ]; then
  $DOCKER run --rm -v "$OUT:/out" "alpine:${ALPINE_VER}" \
    chown -R "$(id -u):$(id -g)" /out >/dev/null 2>&1 || true
fi

echo
echo "==> 产出"
ls -lh "$OUT"
