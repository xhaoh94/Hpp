/* eslint-disable */
/**
 * 审核弹窗首帧滚动的逐帧追踪。
 *
 * 目的：复现「打开停在改动处，约 250ms 后又回到第 1 行」。
 * 做法：用 esbuild 打包真实 CodeReviewDialog + React，在 Electron 里渲染，
 * 每帧记录 .chat-review-diff 的 scrollTop / scrollHeight / 渲染行数 / 是否处于
 * 加载占位，并按变化点打印时间线。
 *
 * 运行：npx electron scripts/review-scroll-trace.cjs [undoDelayMs]
 */
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const chatPanelCss = fs.readFileSync(path.join(root, "src/components/layout/ChatPanel.css"), "utf8");
const globalCss = fs.readFileSync(path.join(root, "src/styles/global.css"), "utf8");
const cssVarsOnly = (globalCss.match(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g) || [])
  .join("\n")
  .replace(/color-scheme:[^;]+;/g, "");

const blockArg = process.argv.find((arg) => arg.startsWith("--block="));
const BLOCK_LINES = Math.max(1, Number(blockArg ? blockArg.slice("--block=".length) : 3) || 3);
const delayArg = process.argv.find((arg) => /^\d+$/.test(arg));
const undoDelayMs = Number(delayArg) || 250;

// 改动在文件中部：默认定位必须滚动，便于观察「滚过去又回来」。
// 取接近真实的尺寸：1200 行文件、改动在第 240 行附近（滚动距离约 5000px）。
const TOTAL_LINES = 1200;
const HUNK_START = 240;
// 第二个 hunk 用于测「点击下一个改动」的滚动动画时长。
const HUNK2_START = 640;
const BASE_LINES = Array.from({ length: TOTAL_LINES }, (_, i) => `line${i + 1}`);
// hunk 上下文是 lineN..lineN+2，新增行插在它们后面（与 patch 语义一致）。
const INSERTED = Array.from({ length: BLOCK_LINES }, (_, i) => `INS${i + 1}`);
const INSERTED2 = Array.from({ length: BLOCK_LINES }, (_, i) => `INS2_${i + 1}`);
const CONTENT = [
  ...BASE_LINES.slice(0, HUNK_START + 2),
  ...INSERTED,
  ...BASE_LINES.slice(HUNK_START + 2, HUNK2_START + 2),
  ...INSERTED2,
  ...BASE_LINES.slice(HUNK2_START + 2),
].join("\n");
const PATCH = [
  "diff --git a/foo.txt b/foo.txt",
  "index 0000000..1111111",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  `@@ -${HUNK_START},3 +${HUNK_START},${3 + BLOCK_LINES} @@`,
  ` line${HUNK_START}`,
  ` line${HUNK_START + 1}`,
  ` line${HUNK_START + 2}`,
  ...INSERTED.map((line) => `+${line}`),
  `@@ -${HUNK2_START},3 +${HUNK2_START + BLOCK_LINES},${3 + BLOCK_LINES} @@`,
  ` line${HUNK2_START}`,
  ` line${HUNK2_START + 1}`,
  ` line${HUNK2_START + 2}`,
  ...INSERTED2.map((line) => `+${line}`),
].join("\n");

const source = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { CodeReviewDialog } from "./src/components/layout/CodeReviewDialog";
  import { parsePatchHunks, buildFullFileDiff } from "@shared/patch-split";

  const content = ${JSON.stringify(CONTENT)};
  const diffs = [{ file: "foo.txt", status: "modified", patch: ${JSON.stringify(PATCH)} }];
  const UNDO_DELAY_MS = ${undoDelayMs};

  const createReviewState = () => ({
    transactionId: "trace-review",
    version: 0,
    files: [{
      file: "foo.txt",
      status: "modified",
      patch: ${JSON.stringify(PATCH)},
      additions: 3,
      deletions: 0,
      hunkCount: 1,
      undoable: true,
      reverted: false,
    }],
    canUndoAll: true,
    allReverted: false,
  });

  window.electronAPI = {
    readFile: async () => ({ success: true, content }),
    // 真实环境这里是 IPC + 主进程 rebuild-file，延迟几十到几百 ms。
    loadReviewUndo: async () => ({ success: true, state: createReviewState() }),
    // 组件实际走的是 prepareReviewUndo（规服化可撤销补丁）。
    prepareReviewUndo: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ success: true, state: createReviewState() }), UNDO_DELAY_MS),
      ),
    applyReviewUndo: async () => ({ success: true, state: createReviewState() }),
    showItemInFolder: async () => {},
  };

  window.__HPP_REVIEW_SCROLL_DEBUG__ = true;
  const rootEl = document.getElementById("root");
  const reactRoot = createRoot(rootEl);
  window.__trace = [];
  let startedAt = 0;

  const sample = () => {
    const el = document.querySelector(".chat-review-diff");
    window.__trace.push({
      t: Math.round(performance.now() - startedAt),
      top: el ? Math.round(el.scrollTop) : -1,
      h: el ? Math.round(el.scrollHeight) : -1,
      rows: document.querySelectorAll("[data-review-row-index]").length,
      loading: !!document.querySelector(".chat-review-loading"),
    });
    requestAnimationFrame(sample);
  };

  // 诊断：patch 解构结果 + 行对照里真正的变更行下标。
  window.__diag = () => {
    const hunks = parsePatchHunks(${JSON.stringify(PATCH)});
    const pairs = buildFullFileDiff(content, ${JSON.stringify(PATCH)});
    const diffIdx = [];
    pairs.forEach((p, i) => {
      if (p.left?.type === "del" || p.right?.type === "add") diffIdx.push(i);
    });
    return {
      hunkCount: hunks.length,
      firstHunk: hunks[0] ? { oldStart: hunks[0].oldStart, newStart: hunks[0].newStart, rows: hunks[0].rows.length } : null,
      pairCount: pairs.length,
      firstDiffIndexes: diffIdx.slice(0, 6),
    };
  };

  window.__clickNext = () => {
    const btn = document.querySelector('[aria-label="下一个修改点"]');
    if (!btn || btn.disabled) return "disabled";
    btn.click();
    return "clicked";
  };

  window.__start = () => {
    startedAt = performance.now();
    window.__trace.length = 0;
    reactRoot.render(
      React.createElement(CodeReviewDialog, {
        open: true,
        reviewId: "trace-review",
        diffs,
        projectPath: "C:/proj",
        onClose: () => {},
        onOpenFile: () => {},
      }),
    );
    requestAnimationFrame(sample);
    return "started";
  };

  // 诊断：变更块整体是否居中（不是只看首行）。
  window.__centerCheck = () => {
    const el = document.querySelector(".chat-review-diff");
    if (!el) return { error: "no-diff" };
    const diffRows = Array.from(el.querySelectorAll("[data-review-diff-index]"));
    if (diffRows.length === 0) return { error: "no-diff-row" };
    const cr = el.getBoundingClientRect();
    const rects = diffRows.map((node) => node.getBoundingClientRect());
    const blockTop = Math.min(...rects.map((r) => r.top));
    const blockBottom = Math.max(...rects.map((r) => r.bottom));
    const containerCenter = cr.top + el.clientHeight / 2;
    return {
      diffRowCount: diffRows.length,
      rowIndexes: diffRows.map((node) => node.getAttribute("data-review-row-index")),
      blockBox: { top: Math.round(blockTop), bottom: Math.round(blockBottom), height: Math.round(blockBottom - blockTop) },
      containerBox: { top: Math.round(cr.top), clientHeight: Math.round(el.clientHeight) },
      // 0 = 变更块整体落在中线上。
      blockOffsetFromCenter: Math.round((blockTop + blockBottom) / 2 - containerCenter),
      scrollTop: Math.round(el.scrollTop),
    };
  };

  // 诊断：改动的行在 DOM 里出现在哪个 row index、第几行文本。
  window.__dump = () => {
    const el = document.querySelector(".chat-review-diff");
    if (!el) return { error: "no-diff" };
    const rows = Array.from(el.querySelectorAll("[data-review-row-index]"));
    const diffRows = Array.from(el.querySelectorAll("[data-review-diff-index]"));
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      renderedRows: rows.length,
      firstRows: rows.slice(0, 4).map((r) => ({
        i: r.getAttribute("data-review-row-index"),
        text: (r.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50),
      })),
      diffRowIndexes: diffRows.slice(0, 6).map((r) => ({
        row: r.getAttribute("data-review-row-index"),
        text: (r.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50),
      })),
    };
  };
`;

const bundle = buildSync({
  stdin: { contents: source, resolveDir: root, sourcefile: "review-scroll-trace.tsx" },
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "text" },
  alias: {
    "@": path.join(root, "src"),
    "@shared": path.join(root, "shared"),
  },
  write: false,
}).outputFiles[0].text;

const html = `<!doctype html><html><head><meta charset="UTF-8"><style>
  html, body, #root { width: 100%; height: 100%; margin: 0; }
  body { background: #1e1e1e; color: #ddd; }
  ${cssVarsOnly}
  ${chatPanelCss}
</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`;

const htmlFile = path.join(app.getPath("temp"), "review-scroll-trace.html");
fs.writeFileSync(htmlFile, html, "utf8");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1200, height: 800 });
  win.webContents.on("console-message", (event) => {
    const message = String(event?.message ?? "");
    if (message.includes("[review-scroll]")) {
      console.log("[renderer]", message);
    } else if ((event?.level ?? 0) >= 2) {
      console.log("[renderer:error]", message);
    }
  });
  await win.loadFile(htmlFile);
  win.show();
  win.focus();
  win.webContents.focus();
  await delay(300);

  await win.webContents.executeJavaScript("window.__start()");
  await delay(2500);

  // 测量「点击下一个改动」的滚动动画时长。
  const traceOffset = await win.webContents.executeJavaScript("window.__trace.length");
  const clickResult = await win.webContents.executeJavaScript("window.__clickNext()");
  await delay(700);
  const fullTrace = await win.webContents.executeJavaScript("window.__trace");
  const seg = fullTrace.slice(traceOffset);
  if (clickResult === "clicked" && seg.length > 1) {
    const finalTop = seg[seg.length - 1].top;
    const startT = seg[0].t;
    const settledAt = seg.find((frame) => frame.top === finalTop)?.t ?? -1;
    console.log(
      `\n=== 下一个改动的滚动动画 ===\n从 ${seg[0].top} 到 ${finalTop}，耗时约 ${settledAt - startT}ms`,
    );
  } else {
    console.log(`\n=== 下一个改动 === 点击结果：${clickResult}`);
  }

  const trace = fullTrace;

  console.log(`\n=== scrollTop 变化时间线（undo 延迟 ${undoDelayMs}ms，共 ${trace.length} 帧）===`);
  let prev = null;
  for (const frame of trace) {
    const changed =
      !prev ||
      frame.top !== prev.top ||
      frame.h !== prev.h ||
      frame.rows !== prev.rows ||
      frame.loading !== prev.loading;
    if (!changed) continue;
    const flags = frame.loading ? " [loading]" : "";
    console.log(
      `t=${String(frame.t).padStart(4)}ms  top=${String(frame.top).padStart(5)}` +
        `  scrollHeight=${String(frame.h).padStart(6)}  rows=${String(frame.rows).padStart(3)}${flags}`,
    );
    prev = frame;
  }

  const last = trace[trace.length - 1];
  const maxTop = trace.reduce((max, f) => Math.max(max, f.top), 0);
  console.log(`\n最大值 top=${maxTop}，最终 top=${last ? last.top : -1}`);
  console.log("\n=== 居中检查 ===");
  console.log(JSON.stringify(await win.webContents.executeJavaScript("window.__centerCheck()")));
  console.log("\n=== DOM 诊断 ===");
  console.log(JSON.stringify(await win.webContents.executeJavaScript("window.__diag()"), null, 2));
  console.log(JSON.stringify(await win.webContents.executeJavaScript("window.__dump()"), null, 2));
  app.exit(0);
});
