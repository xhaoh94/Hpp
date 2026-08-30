/* eslint-disable */
/**
 * 审核弹窗「局部撤销 hunk」e2e 验证：真实 React + 真实 CodeReviewDialog，
 * 按 ReviewUndoService 的真实契约模拟 prepare/apply（version 递增、canonical patch 收缩）。
 * 运行：npx electron scripts/review-undo-e2e.cjs
 */
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const chatPanelCss = fs.readFileSync(path.join(root, "src/components/layout/ChatPanel.css"), "utf8");

const BASE = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
const EDITED = BASE.map((l, i) => (i === 2 ? "line3 EDITED" : i === 25 ? "line26 EDITED" : l));
const content = (lines) => lines.join("\n");

const HUNK1 = ["@@ -1,5 +1,5 @@", " line1", " line2", "-line3", "+line3 EDITED", " line4", " line5"].join("\n");
const HUNK2 = ["@@ -24,3 +24,3 @@", " line24", "-line26", "+line26 EDITED", " line27"].join("\n");
const PATCH_BOTH = ["diff --git a/foo.ts b/foo.ts", "index 1111111..2222222", "--- a/foo.ts", "+++ b/foo.ts", HUNK1, HUNK2].join("\n");
const PATCH_H1_ONLY = ["diff --git a/foo.ts b/foo.ts", "index 1111111..2222222", "--- a/foo.ts", "+++ b/foo.ts", HUNK1].join("\n");

const state = (version, patch, disk) => ({
  transactionId: "e2e-txn",
  version,
  files: [{
    file: "foo.ts",
    status: "modified",
    patch,
    additions: (patch.match(/^\+[^+]/gm) || []).length,
    deletions: (patch.match(/^-[^-]/gm) || []).length,
    hunkCount: (patch.match(/^@@/gm) || []).length,
    undoable: true,
    reverted: false,
  }],
  canUndoAll: true,
  allReverted: false,
});

const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { CodeReviewDialog } from "./src/components/layout/CodeReviewDialog";

const BASE = ${JSON.stringify(BASE)};
const EDITED = ${JSON.stringify(EDITED)};
const content = (lines) => lines.join("\\n");
const HUNK1 = ${JSON.stringify(HUNK1)};
const HUNK2 = ${JSON.stringify(HUNK2)};
const PATCH_BOTH = ${JSON.stringify(PATCH_BOTH)};
const PATCH_H1_ONLY = ${JSON.stringify(PATCH_H1_ONLY)};
const mkState = ${state.toString()};

const calls = [];
let disk = content(EDITED);
let version = 0;
let patch = PATCH_BOTH;

window.__undoE2e = {};
createRoot(document.getElementById("root")).render(
  React.createElement(CodeReviewDialog, {
    key: "undo-e2e",
    open: true,
    reviewId: "review-e2e",
    diffs: [{ file: "foo.ts", status: "modified", patch: PATCH_BOTH }],
    projectPath: "C:/proj",
    onClose: () => {},
    onOpenFile: () => {},
  }),
);
window.electronAPI = {
  readFile: async () => ({ success: true, content: disk }),
  prepareReviewUndo: async () => ({ success: true, state: mkState(version, patch, disk) }),
  applyReviewUndo: async (txn, expectedVersion, target) => {
    calls.push({ txn, expectedVersion, target });
    if (target.kind === "hunk" && target.hunkIndex === 1 && target.changeIndex === 0) {
      version += 1;
      patch = PATCH_H1_ONLY;
      disk = content(EDITED.map((l) => (l === "line26 EDITED" ? "line26" : l)));
      return { success: true, state: mkState(version, patch, disk) };
    }
    return { success: false, error: "unexpected target" };
  },
  showItemInFolder: async () => {},
};

Object.assign(window.__undoE2e, {
  calls: () => calls,
  snapshot() {
    const diff = document.querySelector(".chat-review-diff");
    const text = diff ? diff.textContent : "";
    return {
      hasEdited26: text.includes("line26 EDITED"),
      hasEdited3: text.includes("line3 EDITED"),
      count: (document.querySelector(".chat-review-nav-count") || {}).textContent || null,
      error: (document.querySelector(".chat-review-undo-error") || {}).textContent || null,
      buttons: Array.from(document.querySelectorAll(".chat-review-hunk-undo")).map((b) => ({
        disabled: b.disabled,
        rowText: (b.closest("[class*=chat-review-]") || {}).textContent?.slice(0, 40) || "",
      })),
    };
  },
  clickHunkUndo(rowNeedle) {
    // 撤销按钮挂在修改点首个增删行上：第二个 hunk 的修改点在 line26（del 行在左列）。
    const btn = Array.from(document.querySelectorAll(".chat-review-hunk-undo"))
      .find((b) => !b.disabled && (b.closest(".chat-review-col-line, .chat-review-line")?.textContent || "").includes(rowNeedle));
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  },
});
`;

const bundle = buildSync({
  stdin: { contents: source, resolveDir: root, sourcefile: "review-undo-e2e.tsx" },
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "text" },
  alias: { "@": path.join(root, "src"), "@shared": path.join(root, "shared") },
  write: false,
}).outputFiles[0].text;

const html = `<!doctype html><html><head><meta charset="UTF-8"><style>
  html, body, #root { width: 100%; height: 100%; margin: 0; }
  ${chatPanelCss}
</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`;

const htmlFile = path.join(app.getPath("temp"), "review-undo-e2e.html");
fs.writeFileSync(htmlFile, html, "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({ show: true, width: 1200, height: 800 });
  window.webContents.on("console-message", (e) => { if (e.level >= 2) errors.push(e.message); });
  await window.loadFile(htmlFile);
  await delay(500);

  const exec = (expr) => window.webContents.executeJavaScript(expr, true);
  const before = await exec("window.__undoE2e.snapshot()");
  const click = await exec("window.__undoE2e.clickHunkUndo('line26')");
  await delay(800);
  const after = await exec("window.__undoE2e.snapshot()");
  const calls = await exec("window.__undoE2e.calls()");

  const ok =
    click === "clicked"
    && calls.length === 1
    && calls[0].target.kind === "hunk"
    && calls[0].target.hunkIndex === 1
    && calls[0].target.changeIndex === 0
    && calls[0].expectedVersion === 0
    && after.hasEdited26 === false
    && after.hasEdited3 === true
    && !after.error
    && before.hasEdited26 === true;

  console.log(JSON.stringify({ ok, click, before, after, calls, errors }, null, 2));
  window.destroy();
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
