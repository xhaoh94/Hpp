import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "scripts/install-linux.sh"), "utf8");

describe("Linux 一键安装脚本", () => {
  it("默认安装到用户目录，不强制 sudo", () => {
    expect(source).toContain('INSTALL_DIR="${HPP_INSTALL_DIR:-$HOME/.local/opt/hpp}"');
    expect(source).toContain('BIN_DIR="$HOME/.local/bin"');
    // sudo 只用在系统依赖上，安装自身（建目录 / 落文件 / 写启动器）不能要 sudo。
    expect(source).not.toContain("sudo mkdir");
    expect(source).not.toContain("sudo mv");
    expect(source).not.toContain("sudo cp");
  });

  it("缺 FUSE 时退回解包运行，而不是直接失败", () => {
    expect(source).toContain("APPIMAGE_EXTRACT_AND_RUN=1");
    expect(source).toContain("fusermount");
  });

  it("以 root 运行时给启动器补 --no-sandbox", () => {
    expect(source).toContain('args+=("--no-sandbox")');
  });

  it("下载后会校验体积，避免把 404 页面当成 AppImage", () => {
    expect(source).toContain("-lt 20000000");
  });

  it("重复安装先清理旧 AppImage，避免堆多份", () => {
    expect(source).toContain('find "$INSTALL_DIR" -maxdepth 1 -name "${ASSET_PREFIX}-*.AppImage" -delete');
  });

  it("帮助文本内联，兼容 curl | bash（此时 $0 不是文件）", () => {
    expect(source).toContain("usage() {");
    expect(source).not.toContain('sed -n \'3,22p\' "$0"');
  });

  it("限制在 x86_64，并给出 ARM 的替代做法", () => {
    expect(source).toContain("TARGET_ARCH=\"x86_64\"");
    expect(source).toContain("npm run dist:linux");
  });
});