import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import diffBlockSource from "./DiffBlock.tsx?raw";
import diffHoverCardSource from "./DiffHoverCard.tsx?raw";

const chatPanelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);

describe("diff block viewport constraints", () => {
  it("adds an audit button and mounts the full-screen review dialog", () => {
    expect(diffBlockSource).toContain('className="chat-diff-review-btn"');
    expect(diffBlockSource).toContain("ScanSearch");
    expect(diffBlockSource).toContain("<CodeReviewDialog");
    expect(diffBlockSource).toContain("reviewOpen");
    expect(diffBlockSource).toContain("initialFile");
  });

  it("expands the inline diff panel when a file row is clicked", () => {
    // 点击文件行 = 就地展开该文件的 diff 面板；没有 patch 的文件仍然直接打开文件。
    expect(diffBlockSource).toContain("toggleDiffPreview(file, event.currentTarget)");
    expect(diffBlockSource).toContain("if (!hasPatch) {");
    expect(diffBlockSource).toContain("openDiffFile(file)");
    expect(diffBlockSource).toContain("anchorRect={diffPreview.anchor}");
    expect(diffBlockSource).toContain('aria-expanded={hasPatch ? diffPreview?.file.file === file.file : undefined}');
    // 点击不再直接进审核界面，也不再弹文件预览（那个入口收进了面板按钮）。
    expect(diffBlockSource).not.toContain("setReviewInitialFile(file.file)");
    expect(diffBlockSource).not.toContain('aria-haspopup="dialog"');
    expect(diffBlockSource).toContain("filePath={previewFile}");
  });

  it("keeps the audit button as the only entry to the review dialog", () => {
    expect(diffBlockSource).toContain('className="chat-diff-review-btn"');
    expect(diffBlockSource).toContain("ScanSearch");
    expect(diffBlockSource).toContain("<CodeReviewDialog");
    expect(diffBlockSource).toContain("setReviewOpen(true)");
    expect(diffBlockSource).toContain("reviewInitialFile");
  });

  it("uses the message id as the stable persisted review identity", () => {
    expect(diffBlockSource).toContain("reviewId: string");
    expect(diffBlockSource).toContain("reviewId={reviewId}");
    // 撤销状态经缓存加载：虚拟列表反复挂载时不再每次 IPC + 主进程重算 diff。
    expect(diffBlockSource).toContain("loadReviewUndoState({");
    // 撤销改写磁盘后必须作废缓存，否则滚动回来会展示过期的可撤销摘要。
    expect(diffBlockSource).toContain("invalidateReviewUndoCache(reviewId, projectPath)");
    expect(diffBlockSource).toContain("onUndoStateChange={");
    expect(diffBlockSource).not.toContain("reverseApplyPatch");
  });

  it("notifies the virtualized owner while the review dialog is open", () => {
    expect(diffBlockSource).toContain("onOpenChange?: (open: boolean) => void");
    expect(diffBlockSource).toContain("onOpenChange?.(reviewOpen)");
  });

  it("keeps the desktop summary header as compact as one visible file item", () => {
    const header = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-card-header"),
      chatPanelStyles.indexOf(".chat-diff-icon-box"),
    );
    expect(header).toContain("min-height: 44px");
    expect(header).toContain("padding: 2px 16px");
    expect(chatPanelStyles).toContain(".chat-diff-file-list {");
    expect(chatPanelStyles).toContain("padding: 8px 0;");
    expect(chatPanelStyles).toContain("min-height: 28px;");
  });

  it("does not let a failed undo preparation erase the real change counts", () => {
    // 撤销状态在「准备失败」时带的是占位 0/0（rebuild-file buildState 的 error 分支）。
    // 若直接拿它覆盖，卡片会把 +4 -4 显示成 +0 -0 —— 把「无法安全撤销」
    // 误渲染成「没有改动」。有 error 时必须保留原始 diff 数据。
    expect(diffBlockSource).toContain("if (!undoFile || undoFile.error) return file;");
    expect(diffBlockSource).toContain("additions: undoFile.additions");
    expect(diffBlockSource).toContain("deletions: undoFile.deletions");
  });

  it("preloads the review dialog chunk while idle", () => {
    // 审核弹窗的 chunk 里带着 diff 渲染与语法高亮语言包，首次下载/解析要几百毫秒。
    // 等点“审核”再加载会让弹窗先出现壳、稍后才定位到第一个改动处。
    expect(diffBlockSource).toContain("preloadCodeReviewDialog");
    expect(diffBlockSource).toContain("requestIdleCallback");
  });

  it("opens the shared file context menu on right-click of a diff file row", () => {
    expect(diffBlockSource).toContain("<FileContextMenu");
    expect(diffBlockSource).toContain("onContextMenu={(event) => {");
    expect(diffBlockSource).toContain('resolveProjectFilePath(file.file, projectPath || "")');
    expect(diffBlockSource).toContain("setFileContextMenu(");
  });

  it("keeps the edited-file title and totals on one line", () => {
    const titleGroup = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-title-group"),
      chatPanelStyles.indexOf(".chat-diff-title {"),
    );
    const totals = chatPanelStyles.slice(
      chatPanelStyles.indexOf(".chat-diff-total-stats"),
      chatPanelStyles.indexOf(".chat-diff-revert-btn"),
    );
    expect(titleGroup).toContain("display: flex");
    expect(titleGroup).toContain("align-items: center");
    expect(titleGroup).toContain("gap: 6px");
    expect(totals).toContain("margin-top: 0");
  });
});

describe("diff file inline preview", () => {
  it("opens the floating diff panel on click instead of hover", () => {
    expect(diffBlockSource).toContain("toggleDiffPreview");
    expect(diffBlockSource).toContain("<DiffHoverCard");
    expect(diffBlockSource).toContain("anchorRect={diffPreview.anchor}");
    // 悬停弹出的整套延迟逻辑已删除。
    expect(diffBlockSource).not.toContain("scheduleHoverPreview");
    expect(diffBlockSource).not.toContain("HOVER_PREVIEW_OPEN_DELAY_MS");
    expect(diffBlockSource).not.toContain("onMouseLeave={() => scheduleCloseHoverPreview()}");
    expect(diffBlockSource).not.toContain("onMouseEnter={cancelCloseHoverPreview}");
  });

  it("keeps the full-file entry point inside the panel", () => {
    // 点击行不再直接打开文件，所以「看完整文件」要在面板里保留一个明确入口。
    expect(diffHoverCardSource).toContain("onOpenFile");
    expect(diffHoverCardSource).toContain("chat-diff-hover-card-open");
    expect(diffHoverCardSource).toContain("打开文件");
    expect(diffBlockSource).toContain("openDiffFile(diffPreview.file)");
  });

  it("dismisses the panel on outside click, scroll, resize and Escape", () => {
    expect(diffBlockSource).toContain('window.addEventListener("scroll", handleScroll, true)');
    expect(diffBlockSource).toContain('window.addEventListener("resize", dismiss)');
    expect(diffBlockSource).toContain('window.addEventListener("mousedown", handlePointerDown, true)');
    expect(diffBlockSource).toContain('event.key === "Escape"');
    // 面板内部滚动、再点文件行都不应该被捕获阶段抢先关掉。
    expect(diffBlockSource).toContain('target.closest("[data-diff-hover-card]")');
    expect(diffBlockSource).toContain('target.closest(".chat-diff-file-row")');
  });

  it("renders the card through a portal, clamped to the viewport", () => {
    expect(diffHoverCardSource).toContain("createPortal");
    expect(diffHoverCardSource).toContain("fitsRight");
    expect(diffHoverCardSource).toContain("data-diff-hover-card");
    expect(diffHoverCardSource).toContain("buildDiffPreviewLines");
    expect(chatPanelStyles).toContain(".chat-diff-hover-card {");
    // 宽度/高度跟视口伸缩：窄窗口铺满可用宽度，宽屏最多 1120px。
    expect(chatPanelStyles).toContain("width: clamp(420px, 72vw, 1120px);");
    expect(chatPanelStyles).toContain("max-width: calc(100vw - 24px);");
    expect(chatPanelStyles).toContain("max-height: min(64vh, calc(100vh - 24px));");
  });
});
