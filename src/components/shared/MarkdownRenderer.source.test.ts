import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import diffBlockSource from "./MarkdownRenderer.tsx?raw";

const styles = readFileSync(resolve("src/components/shared/MarkdownRenderer.css"), "utf8");

describe("MarkdownRenderer code block layout", () => {
  it("shrinks short code blocks to their content while keeping long blocks bounded", () => {
    const blockStyles = styles.slice(
      styles.indexOf(".md-content .md-code-block {"),
      styles.indexOf(".md-content .md-code-block pre {"),
    );
    expect(blockStyles).toContain("width: fit-content");
    expect(blockStyles).toContain("min-width: min(240px, 100%)");
    expect(blockStyles).toContain("max-width: 100%");
  });

  it("reserves room for language and copy controls without forcing full width", () => {
    expect(styles).toContain(".md-content .md-code-header");
    expect(styles).toContain("padding: 6px 12px 0 12px");
    expect(styles).toContain("justify-content: space-between");
    expect(styles).toContain(".md-content .md-code-copy-btn");
    expect(styles).toContain("width: 28px");
    expect(styles).toContain("height: 28px");
    expect(styles).toContain("position: static");
  });

  it("keeps long code lines inside the code block scroll container", () => {
    const contentStyles = styles.slice(
      styles.indexOf(".md-content {"),
      styles.indexOf("/* --- Headings --- */"),
    );
    const preStyles = styles.slice(
      styles.indexOf(".md-content .md-code-block pre {"),
      styles.indexOf(".md-content .md-code-block pre code {"),
    );
    expect(contentStyles).toContain("min-width: 0");
    expect(contentStyles).toContain("max-width: 100%");
    expect(preStyles).toContain("min-width: 0");
    expect(preStyles).toContain("max-width: 100%");
    expect(preStyles).toContain("overflow-x: auto");
    expect(preStyles).toContain("padding: 0");
  });
});

describe("MarkdownRenderer runnable code blocks", () => {
  it("shows the run button only for runnable languages, next to copy", () => {
    // 门控走纯函数（runnable-code.ts），不内联语言集合
    expect(diffBlockSource).toContain("getRunnableCodeKind(language, text)");
    expect(diffBlockSource).toContain("{runnableKind && <RunButton text={text} language={runnableKind} />}");
    expect(diffBlockSource).toContain("<CopyButton text={text} />");
    // 运行走 IPC 落盘 + shell.openPath，渲染层不自己拼 file:// URL
    expect(diffBlockSource).toContain("window.electronAPI.runHtmlPreview({ code: text, language })");
    // 运行按钮样式与复制按钮同规格，放在同一动作区
    expect(styles).toContain(".md-content .md-code-actions");
    expect(styles).toContain(".md-content .md-code-run-btn");
  });

  it("wires right-click file menus on links and inline code paths", () => {
    expect(diffBlockSource).toContain("onContextMenu={openMenu}");
    expect(diffBlockSource).toContain("<LinkContextMenu");
    // 本地路径链接：统一的文件菜单（在资源管理器打开/添加到聊天/复制路径...）
    expect(diffBlockSource).toContain("<FileContextMenu");
    expect(diffBlockSource).toContain("getLocalMarkdownFilePath(href)");
    expect(diffBlockSource).toContain("resolveProjectFilePath(local, projectPath)");
    // 内联代码路径同样可右键唤出文件菜单
    expect(diffBlockSource).toContain("md-path-reference");
    expect(diffBlockSource).toContain("onContextMenu");
    expect(diffBlockSource).toContain("resolveProjectFilePath(localPath, projectPath)");
    // 外部链接：交给系统浏览器（与点击行为一致）
    expect(diffBlockSource).toContain('window.open(state.href, "_blank", "noopener,noreferrer")');
    expect(diffBlockSource).toContain("复制链接地址");
    // 菜单 portal 到 body 且同一时刻只开一个
    expect(diffBlockSource).toContain("createPortal(");
    expect(diffBlockSource).toContain("closeActiveLinkMenu?.()");
  });
});
