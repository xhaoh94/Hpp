/* eslint-disable */
/**
 * 审核弹窗「上/下一个修改点」导航 e2e 验证。
 * 用 esbuild 打包真实 CodeReviewDialog + React，在 Electron 中渲染，
 * 注入纯新增（只有 + 没有 -）的 diff，点击「下一个修改点」检查滚动是否发生。
 *
 * 运行：npx electron scripts/review-nav-e2e.cjs
 */
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const chatPanelCss = fs.readFileSync(path.join(root, "src/components/layout/ChatPanel.css"), "utf8");
// 仅提取 :root 变量块（--bg-secondary 等），避免 global.css 的 * 盒模型/
// body overflow 等全局规则干扰滚动导航测试；背景色验证需要这些变量。
const globalCss = fs.readFileSync(path.join(root, "src/styles/global.css"), "utf8");
const cssVarsOnly =
  (globalCss.match(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g) || [])
    .join("\n")
    // 对照实验：color-scheme 会改变 Chromium 渲染/平滑滚动节流，e2e 里去掉。
    .replace(/color-scheme:[^;]+;/g, "");

// 纯新增场景：content 40 行，两个「只增不删」的 hunk。
const PURE_ADD_CONTENT = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
const PURE_ADD_PATCH = [
  "diff --git a/foo.txt b/foo.txt",
  "index 0000000..1111111",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -5,3 +5,6 @@",
  " line5",
  " line6",
  " line7",
  "+INS1",
  "+INS2",
  "+INS3",
  "@@ -20,3 +23,6 @@",
  " line20",
  " line21",
  " line22",
  "+INS4",
  "+INS5",
  "+INS6",
].join("\n");

// 对照组：同样的位置做「替换」（del + add），应能正常定位。
const MIXED_PATCH = [
  "diff --git a/foo.txt b/foo.txt",
  "index 0000000..1111111",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -5,3 +5,3 @@",
  " line5",
  "-line6",
  "+line6x",
  " line7",
  "@@ -20,3 +20,3 @@",
  " line20",
  "-line21",
  "+line21x",
  " line22",
].join("\n");

// 新文件：/dev/null，整个文件都是新增。
const NEW_FILE_CONTENT = Array.from({ length: 60 }, (_, i) => `nline${i + 1}`).join("\n");
const NEW_FILE_PATCH = [
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,60 @@",
  ...Array.from({ length: 60 }, (_, i) => `+nline${i + 1}`),
].join("\n");

// patch-only：已有文件纯新增 patch，但磁盘内容读取失败（文件未写入）。
const PATCH_ONLY_PATCH = PURE_ADD_PATCH;

// 已有文件、单 hunk 纯新增：磁盘内容已应用插入（含 INS 行）。
const SINGLE_ADD_APPLIED_CONTENT = [
  ...Array.from({ length: 7 }, (_, i) => `line${i + 1}`),
  "INS1",
  "INS2",
  "INS3",
  ...Array.from({ length: 33 }, (_, i) => `line${i + 8}`),
].join("\n");
const SINGLE_ADD_APPLIED_PATCH = [
  "diff --git a/foo.txt b/foo.txt",
  "index 0000000..1111111",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -5,3 +5,6 @@",
  " line5",
  " line6",
  " line7",
  "+INS1",
  "+INS2",
  "+INS3",
].join("\n");

// 已有文件、单 hunk 纯新增：磁盘内容未应用（仍是旧内容）。
const SINGLE_ADD_UNAPPLIED_CONTENT = PURE_ADD_CONTENT;
const SINGLE_ADD_UNAPPLIED_PATCH = SINGLE_ADD_APPLIED_PATCH;

// 已有文件、单 hunk 纯新增，修改点在文件中部（默认定位应滚动到中部）。
const MID_ADD_CONTENT = [
  ...Array.from({ length: 32 }, (_, i) => `line${i + 1}`),
  "INS1",
  "INS2",
  "INS3",
  ...Array.from({ length: 28 }, (_, i) => `line${i + 33}`),
].join("\n");
const MID_ADD_PATCH = [
  "diff --git a/foo.txt b/foo.txt",
  "index 0000000..1111111",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -30,3 +30,6 @@",
  " line30",
  " line31",
  " line32",
  "+INS1",
  "+INS2",
  "+INS3",
].join("\n");

const source = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { CodeReviewDialog } from "./src/components/layout/CodeReviewDialog";

  const scenes = {
    pureAdd: {
      content: ${JSON.stringify(PURE_ADD_CONTENT)},
      readOk: true,
      diffs: [
        { file: "foo.txt", status: "modified", patch: ${JSON.stringify(PURE_ADD_PATCH)} },
      ],
    },
    mixed: {
      content: ${JSON.stringify(PURE_ADD_CONTENT)},
      readOk: true,
      diffs: [
        { file: "foo.txt", status: "modified", patch: ${JSON.stringify(MIXED_PATCH)} },
      ],
    },
    newFile: {
      content: ${JSON.stringify(NEW_FILE_CONTENT)},
      readOk: true,
      diffs: [
        { file: "new.txt", status: "added", patch: ${JSON.stringify(NEW_FILE_PATCH)} },
      ],
    },
    patchOnly: {
      content: null,
      readOk: false,
      diffs: [
        { file: "foo.txt", status: "modified", patch: ${JSON.stringify(PATCH_ONLY_PATCH)} },
      ],
    },
    singleApplied: {
      content: ${JSON.stringify(SINGLE_ADD_APPLIED_CONTENT)},
      readOk: true,
      diffs: [
        { file: "foo.txt", status: "modified", patch: ${JSON.stringify(SINGLE_ADD_APPLIED_PATCH)} },
      ],
    },
    singleUnapplied: {
      content: ${JSON.stringify(SINGLE_ADD_UNAPPLIED_CONTENT)},
      readOk: true,
      diffs: [
        { file: "foo.txt", status: "modified", patch: ${JSON.stringify(SINGLE_ADD_UNAPPLIED_PATCH)} },
      ],
    },
    midAdd: {
      content: ${JSON.stringify(MID_ADD_CONTENT)},
      readOk: true,
      diffs: [
        { file: "foo.txt", status: "modified", patch: ${JSON.stringify(MID_ADD_PATCH)} },
      ],
    },
  };

  const createReviewState = (scene) => ({
    transactionId: "e2e-review",
    version: 0,
    files: scene.diffs.map((diff) => ({
      file: diff.file,
      status: diff.status || "modified",
      patch: diff.patch || "",
      additions: (diff.patch?.match(/^\\+[^+]/gm) || []).length,
      deletions: (diff.patch?.match(/^-[^-]/gm) || []).length,
      hunkCount: (diff.patch?.match(/^@@/gm) || []).length,
      undoable: !!diff.patch,
      reverted: false,
    })),
    canUndoAll: true,
    allReverted: false,
  });
  const installElectronAPI = (scene) => {
    window.electronAPI = {
      readFile: async () =>
        scene.readOk
          ? { success: true, content: scene.content }
          : { success: false },
      loadReviewUndo: async () => ({ success: true, state: createReviewState(scene) }),
      prepareReviewUndo: async () => ({ success: true, state: createReviewState(scene) }),
      applyReviewUndo: async () => ({ success: true, state: createReviewState(scene) }),
      showItemInFolder: async () => {},
    };
  };

  let __root = null;
  // 模拟真实使用：组件常驻挂载，仅切换 open 开关（不卸载、状态保留）。
  let reopenOpen = true;
  let reopenScene = null;
  window.__reviewTest = {
    mountReopen(name) {
      reopenScene = scenes[name];
      reopenOpen = true;
      const scene = reopenScene;
      installElectronAPI(scene);
      if (!__root) __root = createRoot(document.getElementById("root"));
      __root.render(
        React.createElement(CodeReviewDialog, {
          key: "reopen-fixed",
          open: reopenOpen,
          reviewId: "review-e2e",
          diffs: scene.diffs,
          projectPath: "C:/proj",
          onClose: () => {},
          onOpenFile: () => {},
        }),
      );
      return "mounted";
    },
    setOpen(value) {
      reopenOpen = !!value;
      const scene = reopenScene;
      __root.render(
        React.createElement(CodeReviewDialog, {
          key: "reopen-fixed",
          open: reopenOpen,
          reviewId: "review-e2e",
          diffs: scene.diffs,
          projectPath: "C:/proj",
          onClose: () => {},
          onOpenFile: () => {},
        }),
      );
      return reopenOpen;
    },
    render(name) {
      const scene = scenes[name];
      installElectronAPI(scene);
      if (!__root) __root = createRoot(document.getElementById("root"));
      __root.render(
        React.createElement(CodeReviewDialog, {
          key: name,
          open: true,
          reviewId: "review-e2e",
          diffs: scene.diffs,
          projectPath: "C:/proj",
          onClose: () => {},
          onOpenFile: () => {},
        }),
      );
      return "rendered";
    },
    state() {
      const diff = document.querySelector(".chat-review-diff");
      const nextBtn = document.querySelector('[aria-label="下一个修改点"]');
      const prevBtn = document.querySelector('[aria-label="上一个修改点"]');
      const count = document.querySelector(".chat-review-nav-count");
      const bg = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      const lines = diff ? Array.from(diff.querySelectorAll("[data-review-diff-index]")) : [];
      // 分别收集左列/右列的有 index 元素及其文本
      const colInfo = (selector) =>
        Array.from(diff.querySelectorAll(selector))
          .map((el) => ({
            idx: el.getAttribute("data-review-diff-index"),
            text: (el.textContent || "").trim().slice(0, 30),
          }))
          .slice(0, 12);
      // 复刻 scrollToDiff 对第二个修改点（idx 25）的居中计算
      const computeCenter = (idx) => {
        const sel =
          '.chat-review-col.right [data-review-diff-index="' + idx + '"]';
        const el = diff ? diff.querySelector(sel) : null;
        if (!el || !diff) return null;
        const cr = diff.getBoundingClientRect();
        const tr = el.getBoundingClientRect();
        const relativeTop = tr.top - cr.top + diff.scrollTop;
        return {
          found: true,
          containerTop: cr.top,
          targetTop: tr.top,
          targetH: tr.height,
          clientH: diff.clientHeight,
          relativeTop,
          centerOffset: relativeTop - diff.clientHeight / 2 + tr.height / 2,
          scrollTopNow: diff.scrollTop,
        };
      };
      // 全部有 index 的元素（右列）
      const allRight = Array.from(
        (diff ? diff.querySelectorAll(".chat-review-col.right [data-review-diff-index]") : []),
      ).map((el) => ({
        idx: el.getAttribute("data-review-diff-index"),
        text: (el.textContent || "").trim().slice(0, 24),
      }));
      // 检查 diffPairIndices 第二个修改点（idx 21）是否存在
      const centerSecond = computeCenter(21);
      const secondExists = centerSecond ? centerSecond.found : false;
      return {
        scrollTop: diff ? diff.scrollTop : -1,
        scrollHeight: diff ? diff.scrollHeight : -1,
        clientHeight: diff ? diff.clientHeight : -1,
        dialogBg: bg(".chat-review-dialog"),
        filesBg: bg(".chat-review-files"),
        diffBg: bg(".chat-review-diff"),
        cellBg: bg(".chat-review-cell.context"),
        lineBg: bg(".chat-review-line.context"),
        nextDisabled: nextBtn ? nextBtn.disabled : null,
        prevDisabled: prevBtn ? prevBtn.disabled : null,
        count: count ? count.textContent : null,
        indexedLineCount: lines.length,
        firstIndexedLineNo: lines.length ? lines[0].textContent : null,
        leftIndexed: colInfo(".chat-review-col.left [data-review-diff-index]"),
        rightIndexed: colInfo(".chat-review-col.right [data-review-diff-index]"),
        allRight,
        centerIdx21: computeCenter(21),
        centerIdx25: computeCenter(25),
      };
    },
    clickNext() {
      const btn = document.querySelector('[aria-label="下一个修改点"]');
      if (!btn || btn.disabled) return "disabled";
      btn.click();
      return "clicked";
    },
    clickPrev() {
      const btn = document.querySelector('[aria-label="上一个修改点"]');
      if (!btn || btn.disabled) return "disabled";
      btn.click();
      return "clicked";
    },
    // 诊断：手动设置滚动位置，验证滚动容器本身是否可滚动（排除 smooth 动画被节流）。
    manualScroll(top) {
      const diff = document.querySelector(".chat-review-diff");
      if (!diff) return "no-diff";
      diff.scrollTop = top;
      return diff.scrollTop;
    },
    // 诊断：复刻 scrollToDiff 的居中计算并返回目标是否存在。
    targetInfo(idx) {
      const diff = document.querySelector(".chat-review-diff");
      const sel = '.chat-review-col.right [data-review-diff-index="' + idx + '"]';
      const el = diff ? diff.querySelector(sel) : null;
      if (!el || !diff) return null;
      const cr = diff.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      return {
        targetTop: tr.top,
        containerTop: cr.top,
        scrollTop: diff.scrollTop,
        scrollHeight: diff.scrollHeight,
        clientHeight: diff.clientHeight,
        centerOffset: tr.top - cr.top + diff.scrollTop - diff.clientHeight / 2 + tr.height / 2,
      };
    },
  };
`;

const bundle = buildSync({
  stdin: { contents: source, resolveDir: root, sourcefile: "review-nav-e2e.tsx" },
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

const htmlFile = path.join(app.getPath("temp"), "review-nav-e2e.html");
fs.writeFileSync(htmlFile, html, "utf8");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({ show: true, width: 1200, height: 800 });
  window.webContents.on("console-message", (event) => {
    if (event.level >= 2) errors.push(event.message);
  });
  await window.loadFile(htmlFile);
  // 后台/无头环境下即使 show:true，页面也可能保持 document.hidden=true，
  // 导致 Chromium 节流 smooth 滚动动画。强制聚焦使页面进入可见状态。
  window.show();
  window.focus();
  window.webContents.focus();
  await delay(300);
  await window.webContents.executeJavaScript(
    "window.__reviewTest.focus?.() || window.focus?.()",
  ).catch(() => {});

  const run = async (name, opts = {}) => {
    await window.webContents.executeJavaScript(`window.__reviewTest.render(${JSON.stringify(name)})`);
    // 等待 readFile 异步完成 + 双 rAF 定位
    await delay(400);
    const initial = await window.webContents.executeJavaScript("window.__reviewTest.state()");
    if (opts.leave) {
      // 单修改点：手动滚动离开，再点「下一个」应回到修改点。
      await window.webContents.executeJavaScript(
        "document.querySelector('.chat-review-diff').scrollTop = 1000",
      );
      await delay(100);
      const left = await window.webContents.executeJavaScript("window.__reviewTest.state()");
      const backClick = await window.webContents.executeJavaScript(
        "window.__reviewTest.clickNext()",
      );
      // hidden 环境下 Chromium 会节流 smooth 滚动（~900ms），需等足动画完成。
      await delay(2500);
      const back = await window.webContents.executeJavaScript("window.__reviewTest.state()");
      return { initial, left, backClick, back };
    }
    const nextClick = await window.webContents.executeJavaScript("window.__reviewTest.clickNext()");
    // 采样 smooth 动画过程；hidden 环境下节流 ~900ms，总采样 2400ms 覆盖。
    const samples = [];
    for (let s = 0; s < 8; s += 1) {
      await delay(300);
      samples.push(
        await window.webContents.executeJavaScript(
          "document.querySelector('.chat-review-diff')?.scrollTop ?? -1",
        ),
      );
    }
    const afterNext = await window.webContents.executeJavaScript("window.__reviewTest.state()");
    const prevClick = await window.webContents.executeJavaScript("window.__reviewTest.clickPrev()");
    await delay(250);
    const afterPrev = await window.webContents.executeJavaScript("window.__reviewTest.state()");
    return { initial, nextClick, samples, afterNext, prevClick, afterPrev };
  };

  const pureAdd = await run("pureAdd");
  const mixed = await run("mixed");

  // ---- 诊断：mixed 点击 next 后滚动为何可能失效 ----
  await window.webContents.executeJavaScript(`window.__reviewTest.render("mixed")`);
  await delay(400);
  const diag = {};
  diag.initial = await window.webContents.executeJavaScript("window.__reviewTest.state()");
  diag.click = await window.webContents.executeJavaScript("window.__reviewTest.clickNext()");
  diag.target22 = await window.webContents.executeJavaScript(
    "window.__reviewTest.targetInfo(22)",
  );
  diag.manualAfterClick = await window.webContents.executeJavaScript(
    "window.__reviewTest.manualScroll(500)",
  );
  diag.stateAfterManual = await window.webContents.executeJavaScript(
    "window.__reviewTest.state()",
  );
  diag.env = await window.webContents.executeJavaScript(
    "({vis: document.visibilityState, focused: document.hasFocus(), hidden: document.hidden, innerW: window.innerWidth, innerH: window.innerHeight})",
  );

  // ---- 重开同文件（组件常驻挂载、状态保留）：关闭后重开应再次自动定位到修改点，
  //      且文件已缓存时立即定位（无需等 readFile / smooth 过渡）。 ----
  // 先 patch scrollTo 记录调用，确认定位 effect 是否执行。
  await window.webContents.executeJavaScript(`(() => {
    if (!window.__scrollCalls) {
      window.__scrollCalls = [];
      const orig = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (...args) {
        const a = args[0];
        window.__scrollCalls.push({
          top: a && typeof a === "object" ? a.top : (typeof a === "number" ? a : null),
          behavior: a && typeof a === "object" ? a.behavior : null,
        });
        return orig.apply(this, args);
      };
    }
    window.__scrollCalls.length = 0;
    return true;
  })()`);
  await window.webContents.executeJavaScript(`window.__reviewTest.mountReopen("midAdd")`);
  await delay(2500); // 首次打开：补丁行 auto 定位 → readFile 后 smooth 过渡到精确位置
  const reopenFirst = await window.webContents.executeJavaScript(
    "window.__reviewTest.state()",
  );
  const reopenFirstCalls = await window.webContents.executeJavaScript(
    "JSON.parse(JSON.stringify(window.__scrollCalls))",
  );
  await window.webContents.executeJavaScript(`window.__reviewTest.setOpen(false)`);
  await delay(200);
  await window.webContents.executeJavaScript(`window.__reviewTest.setOpen(true)`);
  // 重开时 fileContent 已缓存，应 auto 立即定位（无 readFile 等待）。
  await delay(300);
  const reopenSecond = await window.webContents.executeJavaScript(
    "window.__reviewTest.state()",
  );
  const reopenSecondCalls = await window.webContents.executeJavaScript(
    "JSON.parse(JSON.stringify(window.__scrollCalls))",
  );
  const reopenUsable =
    reopenFirst.scrollTop > 100 &&
    reopenSecond.scrollTop > 100 &&
    Math.abs(reopenSecond.scrollTop - reopenFirst.scrollTop) < 50;

  const newFile = await run("newFile", { leave: true });
  const patchOnly = await run("patchOnly", { leave: true });
  const singleApplied = await run("singleApplied", { leave: true });
  const singleUnapplied = await run("singleUnapplied", { leave: true });
  const midAdd = await run("midAdd", { leave: true });

  // 纯新增：至少要有可定位的修改点、且点「下一个」后 scrollTop 变大。
  const pureAddHasDiffs = pureAdd.initial.indexedLineCount > 0 && pureAdd.initial.count !== "0/0";
  const pureAddMoved = pureAdd.initial.scrollTop < pureAdd.afterNext.scrollTop;

  // 对照组：替换（del+add）应能正常定位。
  const mixedHasDiffs = mixed.initial.indexedLineCount > 0;
  const mixedMoved = mixed.initial.scrollTop < mixed.afterNext.scrollTop;

  // 新文件 / patch-only：应能定位到修改点，按钮计数合理。
  const newFileHasDiffs =
    newFile.initial.indexedLineCount > 0 && newFile.initial.count !== "0/0";
  const patchOnlyHasDiffs =
    patchOnly.initial.indexedLineCount > 0 && patchOnly.initial.count !== "0/0";

  // 单修改点纯新增：按钮应可点，滚动离开后点击「下一个」能回到修改点。
  const singleUsable =
    singleApplied.backClick === "clicked" &&
    singleApplied.back.scrollTop < singleApplied.left.scrollTop &&
    midAdd.backClick === "clicked" &&
    midAdd.back.scrollTop > 100 &&
    midAdd.back.scrollTop < midAdd.left.scrollTop;

  const result = {
    ok:
      pureAddHasDiffs &&
      pureAddMoved &&
      mixedHasDiffs &&
      mixedMoved &&
      singleUsable &&
      reopenUsable &&
      errors.length === 0,
    errors,
    pureAdd,
    mixed,
    newFile,
    patchOnly,
    singleApplied,
    singleUnapplied,
    midAdd,
    diag,
    reopen: {
      first: reopenFirst,
      firstCalls: reopenFirstCalls,
      second: reopenSecond,
      secondCalls: reopenSecondCalls,
      usable: reopenUsable,
    },
    summary: {
      pureAddHasDiffs,
      pureAddMoved,
      mixedHasDiffs,
      mixedMoved,
      newFileHasDiffs,
      patchOnlyHasDiffs,
      singleUsable,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  window.destroy();
  app.exit(result.ok ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
