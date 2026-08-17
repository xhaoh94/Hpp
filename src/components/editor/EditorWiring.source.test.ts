import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import appSource from "../../App.tsx?raw";
import titleBarSource from "../layout/TitleBar.tsx?raw";
import fileExplorerSource from "../sidebar/FileExplorer.tsx?raw";
import chatPanelSource from "../layout/ChatPanel.tsx?raw";

const layoutCss = readFileSync(resolve(process.cwd(), "src/components/layout/Layout.css"), "utf8");
const chatPanelCss = readFileSync(resolve(process.cwd(), "src/components/layout/ChatPanel.css"), "utf8");
const electronViteConfig = readFileSync(resolve(process.cwd(), "electron.vite.config.ts"), "utf8");

describe("editor mode wiring", () => {
  it("keeps EditorArea always mounted inside the layout grid", () => {
    expect(appSource).toContain("import { EditorArea }");
    expect(appSource).toContain("<EditorArea />");
  });

  it("toggles the editor-mode class on the layout grid from the store", () => {
    expect(appSource).toContain("const editorMode = useEditorStore((s) => s.mode)");
    expect(appSource).toContain('${editorMode ? "editor-mode" : ""}');
  });

  it("routes Ctrl+P file selection to the editor when editor mode is active", () => {
    expect(appSource).toContain("if (useEditorStore.getState().mode) {");
    expect(appSource).toContain("useEditorStore.getState().openFile(selection.path)");
  });

  it("adds a mode toggle button to the title bar", () => {
    expect(titleBarSource).toContain("toggleEditorMode");
    expect(titleBarSource).toContain("titlebar-mode-btn");
    expect(titleBarSource).toContain("aria-pressed={editorMode}");
    expect(titleBarSource).toContain("Columns2");
    expect(titleBarSource).toContain("uiText.editor.toggleEditorMode");
  });

  it("routes file-tree clicks to the editor in editor mode, preview otherwise", () => {
    expect(fileExplorerSource).toContain("useEditorStore.getState().openFile(path)");
    expect(fileExplorerSource).toContain("setPreviewFile(path)");
  });

  it("routes reveal/preview requests and chat file opens to the editor in editor mode", () => {
    expect(fileExplorerSource).toContain("useEditorStore.getState().openFile(revealRequest.path)");
    expect(chatPanelSource).toContain("useEditorStore.getState().openFile(resolvedPath)");
  });

  it("drives the editor-mode chat width through a CSS variable and resizer", () => {
    expect(appSource).toContain('"--editor-chat-width": `${chatWidth}px`');
    expect(appSource).toContain("className={`chat-resizer ${chatResizing ? \"resizing\" : \"\"}`}");
    expect(appSource).toContain("调整聊天区宽度");
  });

  it("auto-switches back to preview mode when the editor column gets too narrow", () => {
    expect(appSource).toContain("EDITOR_MIN_WIDTH = 240");
    expect(appSource).toContain("editorWidth < EDITOR_MIN_WIDTH");
    expect(appSource).toContain("useEditorStore.getState().setMode(false)");
  });

  it("visually separates the editor and chat columns and hides the resizer outside editor mode", () => {
    expect(layoutCss).toContain(".layout-content.editor-mode > .chat-panel {");
    expect(layoutCss).toContain("border-left: 1px solid var(--border-color)");
    expect(layoutCss).toContain(".layout-content:not(.editor-mode) .chat-resizer {");
    expect(layoutCss).toContain(".chat-resizer {");
    expect(layoutCss).toContain("--editor-chat-width, 380px");
  });

  it("keeps the chat toolbar on a single line with truncated labels when narrow", () => {
    const toolbarRule = chatPanelCss.slice(
      chatPanelCss.indexOf(".chat-input-toolbar {"),
      chatPanelCss.indexOf(".chat-attachment-alert {"),
    );
    expect(toolbarRule).toContain("flex-wrap: nowrap");
    expect(toolbarRule).not.toContain("flex-wrap: wrap");
    expect(chatPanelCss).toContain(".chat-toolbar-select > span {");
    expect(chatPanelCss).toContain("text-overflow: ellipsis");
  });

  it("hides the three left-side locator controls and removes chat content gutters in editor mode", () => {
    expect(layoutCss).toContain("--chat-content-horizontal-gutter: 0px");
    expect(chatPanelCss).toContain(".chat-header-history-anchor");
    expect(chatPanelCss).toContain(".chat-sticky-previous-message");
    expect(chatPanelCss).toContain(".chat-process-sticky");
    expect(chatPanelCss).toContain("display: none !important");
  });

  it("disables renderer HMR so saving a project source file cannot reload the chat window", () => {
    expect(electronViteConfig).toContain("server: {");
    expect(electronViteConfig).toContain("hmr: false");
  });
});
