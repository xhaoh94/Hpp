#!/usr/bin/env bash
#
# Hpp Linux 一键安装脚本（AppImage）
#
#   curl -fsSL https://raw.githubusercontent.com/xhaoh94/Hpp/main/scripts/install-linux.sh | bash
#
# 常用参数：
#   --version v0.1.11   安装指定版本（默认取最新 Release）
#   --dir <路径>        安装到指定目录（默认 ~/.local/opt/hpp）
#   --system            装到 /usr/local（需要 sudo）
#   --no-deps           跳过系统依赖安装（FUSE / Electron 运行库）
#   --uninstall         卸载
#   -h, --help          查看帮助
#
# 环境变量：
#   HPP_VERSION         同 --version
#   HPP_INSTALL_DIR     同 --dir
#
# 设计说明：安装过程不需要 sudo（依赖安装除外）；重复执行等于升级，
# 不会留下多份 AppImage。FUSE 不可用时自动退回解包运行，避免新版
# Ubuntu 上 libfuse2 装不上就完全跑不起来。

set -euo pipefail

REPO="xhaoh94/Hpp"
ASSET_PREFIX="Hpp-Linux"
TARGET_ARCH="x86_64"

INSTALL_DIR="${HPP_INSTALL_DIR:-$HOME/.local/opt/hpp}"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
REQUESTED_VERSION="${HPP_VERSION:-}"
USE_SYSTEM=0
SKIP_DEPS=0
DO_UNINSTALL=0

log() { printf '\033[36m[hpp]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[hpp] 提示：\033[0m %s\n' "$*"; }
die() { printf '\033[31m[hpp] 失败：\033[0m %s\n' "$*" >&2; exit 1; }

# 帮助文本内联：脚本经常通过 curl | bash 执行，此时 $0 不是文件路径，
# 不能再回读自身内容。
usage() {
  cat <<'EOF'
Hpp Linux 一键安装脚本（AppImage）

  curl -fsSL https://raw.githubusercontent.com/xhaoh94/Hpp/main/scripts/install-linux.sh | bash

参数：
  --version <tag>  安装指定版本，例如 --version v0.1.11（默认取最新 Release）
  --dir <path>     安装目录，默认 ~/.local/opt/hpp
  --system         安装到 /usr/local（需要 sudo）
  --no-deps        跳过系统依赖安装
  --uninstall      卸载
  -h, --help       查看帮助

环境变量：
  HPP_VERSION      同 --version
  HPP_INSTALL_DIR  同 --dir
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) REQUESTED_VERSION="${2:-}"; shift 2 ;;
    --version=*) REQUESTED_VERSION="${1#*=}"; shift ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --system)
      INSTALL_DIR="/usr/local/opt/hpp"
      BIN_DIR="/usr/local/bin"
      DESKTOP_DIR="/usr/local/share/applications"
      ICON_DIR="/usr/local/share/icons/hicolor/512x512/apps"
      USE_SYSTEM=1
      shift ;;
    --no-deps) SKIP_DEPS=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1，请先安装。"
}

if [ "$USE_SYSTEM" = "1" ] && [ "$(id -u)" != "0" ]; then
  die "--system 需要写 /usr/local，请用 root 运行：
  curl -fsSL .../install-linux.sh | sudo bash -s -- --system"
fi

# ---------------------------------------------------------------- 卸载

uninstall() {
  log "开始卸载 Hpp"
  rm -f "$BIN_DIR/hpp"
  rm -f "$DESKTOP_DIR/hpp.desktop"
  rm -f "$ICON_DIR/hpp.png"
  if [ -d "$INSTALL_DIR" ]; then
    # 只删本脚本安装的 AppImage，避免误删用户放在同目录的其它文件。
    find "$INSTALL_DIR" -maxdepth 1 -name "${ASSET_PREFIX}-*.AppImage" -delete 2>/dev/null || true
    rmdir "$INSTALL_DIR" 2>/dev/null || true
  fi
  rm -rf "$HOME/.cache/hpp-appimage" 2>/dev/null || true
  log "已卸载。配置文件仍保留在 ~/.config/hpp（需要时手动删除）"
}

if [ "$DO_UNINSTALL" = "1" ]; then
  uninstall
  exit 0
fi

# ---------------------------------------------------------------- 环境检查

case "$(uname -s)" in
  Linux) ;;
  *) die "这个脚本只支持 Linux。Windows / macOS 请从 GitHub Releases 下载安装包。" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ;;
  aarch64|arm64) die "目前只发布 x86_64 AppImage，ARM 设备请从源码构建：npm run dist:linux" ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac

need_cmd curl

# ---------------------------------------------------------------- 版本解析

resolve_version() {
  if [ -n "$REQUESTED_VERSION" ]; then
    printf '%s' "$REQUESTED_VERSION"
    return 0
  fi
  local tag
  tag=$(curl -fsSL --max-time 20 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/') || true
  [ -n "${tag:-}" ] || return 1
  printf '%s' "$tag"
}

TAG="$(resolve_version || true)"
if [ -z "$TAG" ]; then
  die "无法从 GitHub 获取最新版本（可能是网络或 API 限流）。请用 --version v0.1.11 指定版本。"
fi
VERSION="${TAG#v}"
ASSET="${ASSET_PREFIX}-${VERSION}-${TARGET_ARCH}.AppImage"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

log "目标版本：${TAG}"

# ---------------------------------------------------------------- 系统依赖

install_deps() {
  [ "$SKIP_DEPS" = "1" ] && { log "已跳过依赖安装"; return 0; }

  local pm=""
  for candidate in apt-get dnf pacman zypper; do
    command -v "$candidate" >/dev/null 2>&1 && { pm="$candidate"; break; }
  done

  if [ -z "$pm" ]; then
    warn "未识别的包管理器，跳过依赖安装。若启动报错，请手动安装 FUSE 与 Electron 运行库。"
    return 0
  fi

  # 没有免密 sudo 时不阻塞安装：AppImage 缺 FUSE 会自动解包运行。
  if [ "$(id -u)" != "0" ] && ! sudo -n true 2>/dev/null; then
    warn "需要 sudo 安装系统依赖，当前无法免密执行。若启动失败，请手动执行："
    case "$pm" in
      apt-get) warn "  sudo apt install -y libnss3 libgtk-3-0 libgbm1 libasound2" ;;
      dnf)     warn "  sudo dnf install -y nss gtk3 mesa-libgbm alsa-lib" ;;
      pacman)  warn "  sudo pacman -S --noconfirm fuse2 nss gtk3 mesa alsa-lib" ;;
      zypper)  warn "  sudo zypper install -y mozilla-nss gtk3 libgbm1 alsa" ;;
    esac
    return 0
  fi

  local run=""
  if [ "$(id -u)" = "0" ]; then run=""; else run="sudo"; fi

  log "安装 Electron 运行库（$pm）"
  case "$pm" in
    apt-get)
      $run apt-get update -qq || true
      # Electron 的运行时依赖；缺包不致命，所以逐个尝试。
      for pkg in libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
                 libgbm1 libgtk-3-0 libasound2 libasound2t64; do
        $run apt-get install -y -qq "$pkg" >/dev/null 2>&1 || true
      done
      ;;
    dnf) $run dnf install -y nss gtk3 mesa-libgbm alsa-lib >/dev/null 2>&1 || true ;;
    pacman)
      # Arch 的 appimage 运行时依赖 fuse2（Debian 叫 libfuse2）。
      $run pacman -S --noconfirm --needed fuse2 nss gtk3 mesa alsa-lib >/dev/null 2>&1 || true
      ;;
    zypper) $run zypper install -y mozilla-nss gtk3 libgbm1 alsa >/dev/null 2>&1 || true ;;
  esac
}

install_deps

# ---------------------------------------------------------------- 下载

mkdir -p "$INSTALL_DIR"
TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/hpp-XXXXXX.AppImage")"
cleanup() { rm -f "${TMP_FILE:-}"; }
trap cleanup EXIT

log "下载 ${ASSET}"
if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$TMP_FILE" "$URL"; then
  die "下载失败：$URL
  - 检查网络能否访问 download 服务器（可用 curl -I $URL 试一下）
  - 私有镜像/代理环境可以用 --version 指定已发布的版本"
fi

SIZE=$(wc -c < "$TMP_FILE" | tr -d ' ')
if [ "${SIZE:-0}" -lt 20000000 ]; then
  die "下载文件只有 ${SIZE} 字节，明显不是 AppImage（多半是 404 页面或代理拦截）。"
fi

# 清掉旧版本再落地，避免同一目录堆多个 AppImage。
find "$INSTALL_DIR" -maxdepth 1 -name "${ASSET_PREFIX}-*.AppImage" -delete 2>/dev/null || true
TARGET="$INSTALL_DIR/${ASSET}"
mv "$TMP_FILE" "$TARGET"
chmod +x "$TARGET"
log "已安装到 $TARGET"

# ---------------------------------------------------------------- 启动器

mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/hpp"

{
  echo '#!/usr/bin/env bash'
  echo '# 由 Hpp 安装脚本生成；升级会覆盖，不要手改。'
  echo 'set -euo pipefail'
  echo "APPIMAGE=\"$TARGET\""
  echo 'args=("$@")'
  echo '# root 下 Chromium 沙箱不可用，自动补 --no-sandbox。'
  echo 'if [ "$(id -u)" = "0" ]; then args+=("--no-sandbox"); fi'
  echo '# 没有 FUSE 时用解包模式运行，否则 AppImage 会直接报错退出。'
  echo 'if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then'
  echo '  export APPIMAGE_EXTRACT_AND_RUN=1'
  echo 'fi'
  echo 'exec "$APPIMAGE" "${args[@]}"'
} > "$LAUNCHER"
chmod +x "$LAUNCHER"

log "已创建启动器 $LAUNCHER"

# ---------------------------------------------------------------- 桌面入口

if mkdir -p "$DESKTOP_DIR" 2>/dev/null; then
  # 图标从 AppImage 里取，取不到就退化成文字图标。
  ICON_VALUE="hpp"
  if mkdir -p "$ICON_DIR" 2>/dev/null; then
    EXTRACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hpp-icon-XXXXXX")"
    if ( cd "$EXTRACT_DIR" && "$TARGET" --appimage-extract '*.png' >/dev/null 2>&1 ); then
      FOUND=$(find "$EXTRACT_DIR" -name '*.png' -size +1k 2>/dev/null | head -1)
      if [ -n "${FOUND:-}" ]; then
        cp "$FOUND" "$ICON_DIR/hpp.png" 2>/dev/null || true
        [ -f "$ICON_DIR/hpp.png" ] && ICON_VALUE="$ICON_DIR/hpp.png"
      fi
    fi
    rm -rf "$EXTRACT_DIR"
  fi

  cat > "$DESKTOP_DIR/hpp.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Hpp
Comment=本地 Agent 项目管理器
Exec=$LAUNCHER %U
Icon=$ICON_VALUE
Terminal=false
Categories=Development;
StartupWMClass=hpp
EOF
  chmod +x "$DESKTOP_DIR/hpp.desktop" 2>/dev/null || true
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  log "已创建桌面入口"
fi

# ---------------------------------------------------------------- 收尾

log "安装完成：$TAG"
echo

if ! printf '%s' "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  warn "$BIN_DIR 不在 PATH 里，把下面一行加进 ~/.bashrc 或 ~/.zshrc："
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo
  echo "  本次可以直接用绝对路径启动：$LAUNCHER"
else
  echo "  运行：hpp"
fi

cat <<'EOF'

常见参数：
  hpp --quick-ask     只弹出快捷输入条（适合绑定桌面快捷键）
  hpp --no-sandbox    以 root 运行时需要（启动器已自动补）

Wayland 环境如果窗口或输入法异常，可以试：
  HPP_OZONE_PLATFORM=wayland hpp
  HPP_OZONE_PLATFORM=x11 hpp
EOF