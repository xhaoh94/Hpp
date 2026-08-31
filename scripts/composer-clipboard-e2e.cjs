/* eslint-disable */
/**
 * 「复制发言气泡 → 粘贴回输入框」e2e：验证三条路径——
 * 1. 系统剪贴板带自定义格式（跨窗口）→ 芯片还原；
 * 2. 纯文本指纹命中内存副本（同窗口，Electron 下 clipboard.write 可能挂起）→ 芯片还原；
 * 3. 普通纯文本粘贴 → 行为不变。
 * 运行：npx electron scripts/composer-clipboard-e2e.cjs
 */
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");

const source = `
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { InlineComposerEditor } from "./src/components/shared/InlineComposerEditor";
import { createComposerDocument } from "@shared/composer-document";
import {
  COMPOSER_CLIPBOARD_MIME,
  readCopiedComposer,
  serializeComposerClipboard,
  writeComposerClipboard,
} from "./src/lib/composer-clipboard";

const bubbleDocument = createComposerDocument([
  { id: "t1", type: "text", text: "看看这个文件\\n" },
  { id: "p1", type: "path", name: "a.ts", path: "src/a.ts", kind: "file" },
  { id: "s1", type: "session", reference: { sourceSessionId: "s-1", sourceTitle: "会话标题" } },
]);

let latest = bubbleDocument;
const editorRef = { current: null };

createRoot(document.getElementById("root")).render(
  createElement(InlineComposerEditor, {
    value: createComposerDocument([]),
    onChange: (value) => { latest = value; },
    placeholder: "paste here",
    ref: (node) => { editorRef.current = node; },
  }),
);

const describeDocument = () => latest.nodes.map((node) => node.type === "text" ? node.text : node.type);

const dispatchPaste = async (setup) => {
  const data = new DataTransfer();
  setup(data);
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  document.querySelector(".inline-composer-content").dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return describeDocument();
};

// 1) 系统剪贴板带自定义格式（跨窗口场景模拟）
const pasteWithFlavor = () => dispatchPaste((data) => {
  data.setData("text/plain", "纯文本兜底");
  data.setData(COMPOSER_CLIPBOARD_MIME, serializeComposerClipboard(bubbleDocument));
});

// 2) 先用复制按钮的路径写内存副本，再粘贴仅带纯文本的剪贴板（同窗口场景）
const copyThenPastePlain = async () => {
  await writeComposerClipboard(bubbleDocument, "看看这个文件\\n");
  return dispatchPaste((data) => {
    data.setData("text/plain", "看看这个文件\\n");
  });
};

// 3) 普通纯文本粘贴（复制过气泡之后又复制了别的内容）
const pasteForeignPlain = async () => {
  await writeComposerClipboard(bubbleDocument, "看看这个文件\\n");
  return dispatchPaste((data) => {
    data.setData("text/plain", "只是别的文本");
  });
};

const copySmoke = async () => {
  const startedAt = Date.now();
  await writeComposerClipboard(bubbleDocument, "看看这个文件\\n");
  return { elapsedMs: Date.now() - startedAt, restored: !!readCopiedComposer("看看这个文件\\n", null) };
};

window.__clipE2e = { pasteWithFlavor, copyThenPastePlain, pasteForeignPlain, copySmoke };
`;

const bundle = buildSync({
  stdin: { contents: source, resolveDir: root, sourcefile: "composer-clipboard-e2e.tsx" },
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "text" },
  alias: { "@": path.join(root, "src"), "@shared": path.join(root, "shared") },
  write: false,
}).outputFiles[0].text;

const html = `<!doctype html><html><head><meta charset="UTF-8"></head>
<body><div id="root"></div><script>${bundle}</script></body></html>`;
const htmlFile = path.join(app.getPath("temp"), "composer-clipboard-e2e.html");
fs.writeFileSync(htmlFile, html, "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({ show: false, width: 900, height: 600 });
  window.webContents.on("console-message", (e) => { if (e.level >= 3) errors.push(e.message); });
  await window.loadFile(htmlFile);
  await delay(400);
  const exec = (expr) => window.webContents.executeJavaScript(expr, true);

  const withFlavor = await exec("window.__clipE2e.pasteWithFlavor()");
  const memoryMatch = await exec("window.__clipE2e.copyThenPastePlain()");
  const foreign = await exec("window.__clipE2e.pasteForeignPlain()");
  const smoke = await exec("window.__clipE2e.copySmoke()");

  const CHIP_DOC = JSON.stringify(["看看这个文件\n", "path", "session"]);
  const flavorOk = JSON.stringify(withFlavor) === CHIP_DOC;
  const memoryOk = JSON.stringify(memoryMatch) === JSON.stringify(["看看这个文件\n", "path", "session", "看看这个文件\n", "path", "session"]);
  // 指纹失配（用户复制了别的内容）→ 只走普通纯文本粘贴，不注入芯片。
  const foreignOk = JSON.stringify(foreign) === JSON.stringify([
    "看看这个文件\n", "path", "session",
    "看看这个文件\n", "path", "session",
    "只是别的文本",
  ]);
  const copyOk = smoke.restored === true && smoke.elapsedMs < 4000;

  const ok = flavorOk && memoryOk && foreignOk && copyOk && errors.length === 0;
  console.log(JSON.stringify({ ok, flavorOk, memoryOk, foreignOk, copyOk, smoke, withFlavor, memoryMatch, foreign, errors }, null, 2));
  window.destroy();
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
