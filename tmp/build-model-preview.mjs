// 生成模型列表「改前/改后」对照预览页：把真实的 CSS 内联进去，保证和 app 里一致。
// 用法：node tmp/build-model-preview.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = [
  "src/styles/global.css",
  "src/components/sidebar/Sidebar.css",
  "src/components/sidebar/Settings.css",
].map((p) => `/* ===== ${p} ===== */\n${readFileSync(resolve(root, p), "utf8")}`).join("\n");

const grip = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>`;
const trash = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`;
const refresh = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`;
const plus = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
const chevron = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

const header = (actions) => `
      <div class="agent-config-models-header">
        <span></span>
        <span class="agent-config-model-head-label">模型 ID</span>
        <span class="agent-config-model-head-label">显示名</span>
        <div class="agent-config-model-actions">${actions}</div>
      </div>`;

const builtinRow = (id, name, legacy) => `
      <div class="agent-config-model-row builtin">
        <span class="agent-config-model-drag" title="拖动调整模型顺序">${grip}</span>
        <input class="input-field" value="${id}" />
        <input class="input-field agent-config-model-display-name" value="${name}" />
        ${legacy ? `<div class="agent-config-model-checks" aria-hidden="true"></div>` : ""}
        <button type="button" class="btn-icon btn-delete" title="删除模型">${trash}</button>
      </div>`;

const customRow = (id, name) => `
      <div class="agent-config-model-row custom">
        <span class="agent-config-model-drag" title="拖动调整模型顺序">${grip}</span>
        <input class="input-field" value="${id}" />
        <input class="input-field agent-config-model-display-name" value="${name}" />
        <div class="agent-config-model-checks">
          <label class="agent-config-check"><input type="checkbox" checked /> 图片</label>
          <label class="agent-config-thinking-levels"><span>思考档位</span>
            <div class="agent-thinking-multiselect">
              <div class="agent-thinking-multiselect-trigger"><span>中、高</span>${chevron}</div>
            </div>
          </label>
        </div>
        <button type="button" class="btn-icon btn-delete" title="删除模型">${trash}</button>
      </div>`;

const panel = (legacy) => `
    <div class="agent-config-models-panel">
      ${header(`<button type="button" class="btn-action agent-config-mini-btn">${refresh}获取模型</button>
        <button type="button" class="btn-action agent-config-mini-btn">${plus}添加模型</button>`)}
      <div class="agent-config-model-list">
        ${builtinRow("gpt-6-astra", "gpt-6-astra", legacy)}
        ${builtinRow("gpt-5.6-sol", "gpt-5.6-sol", legacy)}
        ${builtinRow("gpt-5.6-luna", "gpt-5.6-luna", legacy)}
        ${customRow("my-finetune-v3", "微调模型 v3")}
      </div>
    </div>`;

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>模型列表 改前/改后对照</title>
<style>
${css}
</style>
<style>
/* 预览页外壳 */
body { margin: 0; padding: 28px; background: var(--bg-secondary); font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
.preview-title { margin: 0 0 4px; color: var(--text-primary); font-size: 14px; font-weight: 600; }
.preview-note { margin: 0 0 12px; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.preview-block { margin-bottom: 34px; }
.preview-canvas { width: 1000px; max-width: 100%; }
.preview-canvas .agent-config-form { height: 470px; }
.preview-badge { display: inline-block; margin-bottom: 8px; padding: 2px 8px; border-radius: 999px; font-size: 11px; }
.preview-badge.legacy { background: rgba(244, 71, 71, 0.16); color: #f48771; }
.preview-badge.fixed { background: rgba(16, 185, 129, 0.16); color: #10b981; }

/* ===== 下面这些只是把改动前的规则复刻回 .legacy，用来做对照 ===== */
.legacy .agent-config-models-panel { padding: 13px; border-radius: 8px; background: var(--bg-tertiary); }
.legacy .agent-config-models-header { padding: 0 9px; margin-bottom: 8px; border-bottom: 0; background: transparent; }
.legacy .agent-config-model-head-label { padding-left: 0; letter-spacing: 0; text-align: center; }
.legacy .agent-config-models-header .agent-config-mini-btn { padding: 3px 8px; border-color: var(--border-color); background: var(--bg-primary); }
.legacy .agent-config-model-list { padding: 2px 4px 2px 1px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-primary); overflow: hidden; }
.legacy .agent-config-model-row { padding: 7px 9px; border-radius: 0; }
.legacy .agent-config-model-row .input-field { height: auto; padding: 6px 9px; margin-bottom: 6px; border-radius: 4px; }
.legacy .agent-config-model-row > .btn-delete { grid-column: auto; opacity: 1; }
.legacy .agent-config-model-drag { height: 22px; opacity: 1; border-radius: 4px; }
.legacy .agent-config-model-row .agent-thinking-multiselect-trigger { height: 32px; }
</style>
</head>
<body>
<h1 class="preview-title">渠道模型列表：改前 / 改后</h1>
<p class="preview-note">
  两侧都用真实 CSS 渲染，宽度与行内容一致（3 个内置模型 + 1 个自定义模型）。<br />
  鼠标移到行上可以看到 hover 高亮、拖拽手柄与删除按钮的显隐效果（仅「改后」一侧有）。
</p>

<div class="preview-block">
  <span class="preview-badge legacy">改前</span>
  <div class="preview-canvas legacy">
    <div class="agent-config-form">${panel(true)}</div>
  </div>
</div>

<div class="preview-block">
  <span class="preview-badge fixed">改后</span>
  <div class="preview-canvas">
    <div class="agent-config-form">${panel(false)}</div>
  </div>
</div>
</body>
</html>`;

const out = resolve(root, "tmp/model-list-preview.html");
writeFileSync(out, html, "utf8");
console.log("written:", out, html.length, "chars");
