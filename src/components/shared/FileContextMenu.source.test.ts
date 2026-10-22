import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import fileContextMenuSource from "./FileContextMenu.tsx?raw";

const styles = readFileSync(resolve("src/components/shared/FileContextMenu.css"), "utf8");

describe("FileContextMenu", () => {
  it("mirrors the file explorer actions for clickable files in chat content", () => {
    expect(fileContextMenuSource).toContain("在资源管理器打开");
    expect(fileContextMenuSource).toContain("window.electronAPI.showItemInFolder(path)");
    expect(fileContextMenuSource).toContain("添加到聊天");
    expect(fileContextMenuSource).toContain("window.electronAPI.statPath(path)");
    expect(fileContextMenuSource).toContain("addPendingPathAttachment");
    expect(fileContextMenuSource).toContain("复制路径");
    expect(fileContextMenuSource).toContain("复制相对路径");
    expect(fileContextMenuSource).toContain("复制名字");
    expect(fileContextMenuSource).toContain("navigator.clipboard.writeText");
  });

  it("renders as a fixed portal that closes on outside interactions", () => {
    expect(fileContextMenuSource).toContain("createPortal(");
    expect(fileContextMenuSource).toContain("document.body");
    expect(fileContextMenuSource).toContain('document.addEventListener("mousedown"');
    expect(fileContextMenuSource).toContain('event.key === "Escape"');
    expect(fileContextMenuSource).toContain("window.addEventListener(\"scroll\", onClose, true)");
    expect(styles).toContain(".file-context-menu {");
    expect(styles).toContain("position: fixed");
  });
});
