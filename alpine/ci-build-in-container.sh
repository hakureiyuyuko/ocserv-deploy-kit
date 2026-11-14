#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# ============================================================================
#  在 Alpine 容器内构建发行包（由 alpine/build-package.sh 调用）
#  环境变量：VERSION / OCSERV_VERSION / ARCH
#  挂载：/src（只读仓库） /out（输出目录）
# ============================================================================
set -eu

: "${VERSION:?需要 VERSION}"
: "${OCSERV_VERSION:?需要 OCSERV_VERSION}"
: "${ARCH:=x86_64}"

SRC=/src
OUT=/out
WORK=/tmp/build

say() { printf '\n==> %s\n' "$*"; }

mkdir -p "$WORK" "$OUT"

say "安装构建依赖"
apk update >/dev/null
apk add --no-cache build-base meson ninja pkgconf \
  gnutls-dev libev-dev protobuf-c-dev readline-dev linux-pam-dev \
  libseccomp-dev krb5-dev oath-toolkit-dev libnl3-dev \
  curl xz nodejs >/dev/null

say "编译 ocserv ${OCSERV_VERSION}"
cd "$WORK"
curl -fsSL -o "ocserv.tar.xz" "https://www.infradead.org/ocserv/download/ocserv-${OCSERV_VERSION}.tar.xz"
xz -dc "ocserv.tar.xz" | tar xf -
cd "ocserv-${OCSERV_VERSION}"
meson setup build --prefix=/usr --sbindir=/usr/sbin --sysconfdir=/etc \
  -Dtests=false -Dsystemd=disabled -Dgssapi=disabled -Dradius=disabled \
  -Dmaxmind=disabled -Dgeoip=disabled -Dpam=enabled -Dseccomp=enabled \
  -Dliboath=enabled -Dlibnl=enabled >/dev/null
ninja -C build >/dev/null
./build/src/ocserv --version | head -1

say "组装发行包"
NAME="ocserv-deploy-kit-alpine-${ARCH}-${VERSION}"
PKG="/tmp/pkg/$NAME"
rm -rf /tmp/pkg
mkdir -p "$PKG/bin" "$PKG/lib" "$PKG/openrc" "$PKG/ocserv-panel"

cp build/src/ocserv "$PKG/bin/ocserv.real"
cp /usr/bin/node      "$PKG/bin/node.real"

# 依赖库解引用后扁平化（跳过 musl 加载器，用系统的）
bundle_libs() {
  for f in $(ldd "$1" | awk '/=> \//{print $3}'); do
    b=$(basename "$f")
    case "$b" in ld-musl*) continue;; esac
    [ -e "$PKG/lib/$b" ] || cp -L "$f" "$PKG/lib/$b"
  done
}
bundle_libs build/src/ocserv
bundle_libs /usr/bin/node

# 启动包装脚本：带 LD_LIBRARY_PATH 指向包内 lib
for n in ocserv node; do
  {
    echo '#!/bin/sh'
    echo 'SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")'
    echo 'DIR=$(dirname "$SELF")'
    echo 'LD_LIBRARY_PATH="$DIR/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"'
    echo 'export LD_LIBRARY_PATH'
    echo "exec \"\$DIR/$n.real\" \"\$@\""
  } > "$PKG/bin/$n"
done
chmod 755 "$PKG/bin/"*

cp -a "$SRC/alpine/install.sh" "$SRC/alpine/uninstall.sh" "$SRC/alpine/README.md" "$PKG/"
cp -a "$SRC/alpine/openrc/." "$PKG/openrc/"
cp -a "$SRC/ocserv-panel/server.js" "$SRC/ocserv-panel/lib" \
      "$SRC/ocserv-panel/public" "$SRC/ocserv-panel/templates" \
      "$SRC/ocserv-panel/README.md" "$PKG/ocserv-panel/"
echo "$VERSION" > "$PKG/VERSION"
chmod 755 "$PKG/install.sh" "$PKG/uninstall.sh" "$PKG/openrc/"*

say "自检（用包内二进制/库）"
"$PKG/bin/ocserv" --version | head -1
"$PKG/bin/node" -v

say "打 tar.gz"
tar czf "$OUT/$NAME.tar.gz" -C /tmp/pkg "$NAME"
ls -lh "$OUT/$NAME.tar.gz"
