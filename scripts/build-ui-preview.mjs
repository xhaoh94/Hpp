/**
 * 把 docs/ui-preview/hpp-ui.html 打包成自包含的预览文件：
 * 应用 CSS 全部内联进 <style>，这样右侧预览面板（file:// 或静态服务）
 * 都能拿到完整样式，不会因为相对路径 404 变成裸 HTML。
 *
 *   node scripts/build-ui-preview.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");

const cssFiles = [
  "src/styles/global.css",
  "src/components/layout/ChatPanel.css",
  "src/components/layout/SubagentMonitor.css",
  "src/components/shared/MarkdownRenderer.css",
  "src/components/git/GitWorkspaceModal.css",
];

const source = read("docs/ui-preview/hpp-ui.html");
const css = cssFiles.map((file) => `/* ${file} */\n${read(file)}`).join("\n");

const output = source
  .replace(/\n<link rel="stylesheet"[^>]*>/g, "")
  .replace("</head>", `<style>\n${css}\n</style>\n</head>`);

writeFileSync(resolve(root, "docs/ui-preview/hpp-ui.standalone.html"), output, "utf8");
console.log(`ok: docs/ui-preview/hpp-ui.standalone.html (${(output.length / 1024).toFixed(0)} KB)`);
