// 生成 Agent 渠道配置界面「改前/改后」对照预览。
// 改前 = git HEAD 里的 CSS + 改动前的 JSX 结构；改后 = 当前工作区。
// 用法：node tmp/build-agent-ui-preview.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSS_FILES = [
  "src/styles/global.css",
  "src/components/sidebar/Sidebar.css",
  "src/components/sidebar/Settings.css",
];

const localCss = () => CSS_FILES.map((p) => `/* ===== ${p} ===== */\n${readFileSync(resolve(root, p), "utf8")}`).join("\n");
const headCss = () =>
  CSS_FILES.map((p) => {
    const text = execFileSync("git", ["show", `HEAD:${p}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return `/* ===== ${p} (HEAD) ===== */\n${text}`;
  }).join("\n");

const icon = {
  grip: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
  pencil: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>`,
  copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  chevron: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
  bot: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 5v3"/><path d="M9 13h.01"/><path d="M15 13h.01"/></svg>`,
  brain: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M8 8h8"/></svg>`,
  zap: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
  save: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>`,
  x: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>`,
  eye: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>`,
};

const providers = [
  { name: "YLK 中转", url: "https://api.ylk.example/v1", id: "ylk", models: 12, active: true, selected: true },
  { name: "Pixel Proxy", url: "https://api.pixel.example/v1", id: "pixel", models: 8, active: false, selected: false },
  { name: "wanzi", url: "https://api.wanzi.example/v1", id: "wanzi", models: 5, active: false, selected: false },
];

const providerRow = (p) => `
            <div class="agent-config-provider-item ${p.selected ? "selected" : ""} ${p.active ? "active" : ""}">
              <span class="agent-config-provider-drag" title="拖动调整渠道顺序">${icon.grip}</span>
              <div class="agent-config-provider-avatar">${p.name.slice(0, 1).toUpperCase()}</div>
              <div class="agent-config-provider-main">
                <div class="agent-config-provider-title-line">
                  <span class="agent-config-provider-name">${p.name}</span>
                  ${p.active ? `<span class="agent-config-provider-check">${icon.check}</span>` : ""}
                </div>
                <span class="agent-config-provider-url">${p.url}</span>
                <span class="agent-config-provider-id">${p.id} · ${p.models} 个模型</span>
              </div>
              <div class="agent-config-provider-actions">
                ${p.active
                  ? `<span class="agent-config-active-badge">当前</span>`
                  : `<button type="button" class="btn-action agent-config-mini-btn">启用</button>`}
              </div>
            </div>`;

const summaryCells = (v) => [
  ["渠道名", "YLK 中转"],
  ["渠道 URL", "https://api.ylk.example/v1"],
  ["Endpoint", "OpenAI Responses"],
  ["鉴权方式", "Bearer Token"],
  // 改前多一张和「模型」徽标重复的统计卡。
  ...(v === "before" ? [["模型数量", "12"]] : []),
].map(([k, val]) => `
            <div class="agent-config-summary-row"><span>${k}</span><strong>${val}</strong></div>`).join("");

const summaryModels = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5-orbit", "o5-mini"].map((id) => `
              <div class="agent-config-summary-model"><span>${id}</span><code>${id}</code></div>`).join("");

const mainModal = (v) => `
      <div class="settings-modal-overlay agent-config-modal-overlay">
        <div class="settings-modal agent-config-modal">
          <div class="settings-modal-header agent-config-header">
            <div class="agent-config-header-main">
              <div class="agent-config-title-row">
                <h3>Hpp Agent 配置</h3>
                ${v === "after" ? `<span class="agent-config-subtitle">~/.pi/agents/hpp/config.json</span>` : ""}
              </div>
              ${v === "after" ? "" : `<div class="agent-config-subtitle">~/.pi/agents/hpp/config.json</div>`}
              <div class="agent-config-tabbar">
                <div class="agent-config-tabs" role="tablist">
                  <button class="agent-config-tab active">Hpp</button>
                  <button class="agent-config-tab">Pi</button>
                  <button class="agent-config-tab">Codex</button>
                </div>
                <div class="agent-config-io-entry-actions">
                  <button class="filter-add-btn agent-config-io-entry-btn">${icon.plus}导入</button>
                  <button class="filter-add-btn agent-config-io-entry-btn">${icon.save}导出</button>
                </div>
              </div>
            </div>
            <button type="button" class="settings-modal-close">${icon.x}</button>
          </div>
          <div class="settings-modal-content agent-config-content">
            <div class="agent-config-toolbar">
              <span>渠道与模型写在 ~/.pi/agents/hpp/config.json；改完要点启用才会重载当前会话。</span>
              <div class="agent-config-toolbar-actions">
                <label class="agent-config-model-visibility"><span>显示内置模型</span><input type="checkbox" checked /></label>
                <button type="button" class="btn-action">${icon.bot}SubAgent</button>
                <button type="button" class="btn-action">${icon.brain}上下文压缩</button>
                <button type="button" class="btn-action">${icon.refresh}重新载入当前配置</button>
              </div>
            </div>
            <div class="agent-config-grid">
              <aside class="agent-config-provider-list">
                ${v === "after"
                  ? `<div class="agent-config-pane-title"><span class="agent-config-section-title">渠道</span><span class="agent-config-count">3</span></div>`
                  : `<div class="agent-config-section-title">渠道</div>`}
                <div class="agent-config-provider-scroll">
                  ${providers.map(providerRow).join("")}
                </div>
                <button type="button" class="filter-add-btn agent-config-add-provider">${icon.plus}新增渠道</button>
              </aside>
              <section class="agent-config-form">
                <div class="agent-config-form-header">
                  ${v === "after"
                    ? `<div class="agent-config-pane-title"><span class="agent-config-section-title">YLK 中转</span><span class="agent-config-form-caption">ylk</span></div>`
                    : `<div class="agent-config-section-title">渠道配置</div>`}
                  <div class="agent-config-form-actions">
                    <button type="button" class="btn-action">${icon.pencil}编辑</button>
                    <button type="button" class="btn-action">${icon.copy}复制</button>
                    <button type="button" class="btn-action ${v === "after" ? "agent-config-danger-btn" : ""}">${icon.trash}删除</button>
                  </div>
                </div>
                <div class="agent-config-summary">${summaryCells(v)}</div>
                <div class="agent-config-summary-models">
                  ${v === "after"
                    ? `<div class="agent-config-pane-title"><span class="agent-config-section-title">模型</span><span class="agent-config-count">12</span></div>`
                    : `<div class="agent-config-section-title">模型</div>`}
                  <div class="agent-config-summary-model-list">${summaryModels}</div>
                </div>
                <button type="button" class="filter-add-btn agent-config-activate-wide">${icon.zap}启用此渠道并重载</button>
              </section>
            </div>
            <div class="status-message success">渠道已保存</div>
          </div>
        </div>
      </div>`;

const field = (label, value, extra = "") => `
                <label${extra ? ` class="${extra}"` : ""}>
                  <span>${label}</span>
                  <input class="input-field" value="${value}" />
                </label>`;

const secretField = `
                <label class="agent-config-field-wide">
                  <span>sk-key</span>
                  <div class="agent-config-secret-input">
                    <input class="input-field" value="sk-abcdefghijklmnopqrstuvwxyz" />
                    <button type="button" class="btn-icon agent-config-secret-btn">${icon.eye}</button>
                    <button type="button" class="btn-icon agent-config-secret-btn">${icon.copy}</button>
                  </div>
                </label>`;

const editorModal = (v) => `
      <div class="settings-modal-overlay agent-provider-editor-overlay">
        <div class="settings-modal agent-provider-editor-modal">
          <div class="settings-modal-header">
            <div>
              <h3>编辑渠道</h3>
              <div class="agent-config-subtitle">ylk</div>
            </div>
            <div class="agent-config-form-actions">
              <span class="agent-config-dirty-hint">未保存</span>
              <button type="button" class="filter-add-btn" title="保存渠道（Ctrl+S）">${icon.save}保存</button>
              <button type="button" class="settings-modal-close">${icon.x}</button>
            </div>
          </div>
          <div class="settings-modal-content agent-provider-editor-content">
            <div class="agent-config-fields">
              ${v === "after" ? `<div class="agent-config-group-title">连接信息</div>` : ""}
              ${field("渠道 ID", "ylk")}
              ${field("渠道名", "YLK 中转")}
              ${field("渠道 URL", "https://api.ylk.example/v1")}
              ${field("Endpoint", "OpenAI Responses")}
              ${field("鉴权方式", "Bearer Token")}
              ${v === "after" ? secretField : ""}
            </div>
            ${v === "after" ? "" : `<div class="agent-config-fields">${secretField}</div>`}
            <div class="agent-config-models-panel">
              <div class="agent-config-models-header">
                <span></span>
                <span class="agent-config-model-head-label">模型 ID</span>
                <span class="agent-config-model-head-label">显示名</span>
                <div class="agent-config-model-actions">
                  <button type="button" class="btn-action agent-config-mini-btn">${icon.refresh}获取模型</button>
                  <button type="button" class="btn-action agent-config-mini-btn">${icon.plus}添加模型</button>
                </div>
              </div>
              <div class="agent-config-model-list">
                ${["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"].map((id) => `
                <div class="agent-config-model-row builtin">
                  <span class="agent-config-model-drag">${icon.grip}</span>
                  <input class="input-field" value="${id}" />
                  <input class="input-field agent-config-model-display-name" value="${id}" />
                  ${v === "after" ? "" : `<div class="agent-config-model-checks" aria-hidden="true"></div>`}
                  <button type="button" class="btn-icon btn-delete">${icon.trash}</button>
                </div>`).join("")}
                <div class="agent-config-model-row custom">
                  <span class="agent-config-model-drag">${icon.grip}</span>
                  <input class="input-field" value="my-finetune-v3" />
                  <input class="input-field agent-config-model-display-name" value="微调模型 v3" />
                  <div class="agent-config-model-checks">
                    <label class="agent-config-check"><input type="checkbox" checked /> 图片</label>
                    <label class="agent-config-thinking-levels"><span>思考档位</span>
                      <div class="agent-thinking-multiselect"><div class="agent-thinking-multiselect-trigger"><span>中、高</span>${icon.chevron}</div></div>
                    </label>
                  </div>
                  <button type="button" class="btn-icon btn-delete">${icon.trash}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

function page({ css, variant }) {
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>渠道配置界面 · ${variant === "before" ? "改前" : "改后"}</title>
<style>
${css}
</style>
<style>
/* ===== 预览页专用：把 fixed 的遮罩改成静态块，方便多屏并排对照 ===== */
body { margin: 0; padding: 20px; background: var(--bg-primary); font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
.preview-frame { margin-bottom: 22px; }
.preview-frame > .settings-modal-overlay { position: static; inset: auto; background: transparent; display: block; padding: 0; }
.preview-frame .settings-modal { margin: 0 auto; height: 620px; max-height: 620px; }
.preview-caption { margin: 0 0 8px; color: var(--text-secondary); font-size: 12px; }
</style>
</head>
<body>
<div class="preview-frame">
  <p class="preview-caption">1 / 主弹窗：渠道概览</p>
  ${mainModal(variant)}
</div>
<div class="preview-frame">
  <p class="preview-caption">2 / 编辑渠道弹窗</p>
  ${editorModal(variant)}
</div>
</body>
</html>`;
}

writeFileSync(resolve(root, "tmp/preview-before.html"), page({ css: headCss(), variant: "before" }), "utf8");
writeFileSync(resolve(root, "tmp/preview-after.html"), page({ css: localCss(), variant: "after" }), "utf8");

// 对照页：两个 iframe 上下叠放，各 1200px 宽（保证命中 >1080px 的宽屏分支）
const compare = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>渠道配置界面 改前 / 改后 对照</title>
<style>
body { margin: 0; padding: 20px; background: #1b1b1c; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
h1 { margin: 0 0 4px; color: #e6e6e6; font-size: 15px; font-weight: 600; }
p.note { margin: 0 0 16px; color: #8a8a8a; font-size: 12px; line-height: 1.7; }
.tag { display: inline-block; margin: 0 0 8px; padding: 2px 9px; border-radius: 999px; font-size: 11px; }
.tag.before { background: rgba(244, 71, 71, 0.16); color: #f48771; }
.tag.after { background: rgba(16, 185, 129, 0.16); color: #10b981; }
iframe { width: 1200px; height: 1420px; border: 1px solid #333; border-radius: 8px; background: #1e1e1e; }
section { margin-bottom: 26px; }
</style>
</head>
<body>
<h1>渠道配置界面：改前 / 改后</h1>
<p class="note">两屏都是真实 CSS 渲染（改前一屏用的是 git HEAD 里的样式与旧结构），宽度 1200px 命中宽屏分支。悬停可以看到行高亮、拖拽手柄与行内操作的显隐。</p>
<section>
  <span class="tag before">改前</span>
  <iframe src="./preview-before.html" title="改前"></iframe>
</section>
<section>
  <span class="tag after">改后</span>
  <iframe src="./preview-after.html" title="改后"></iframe>
</section>
</body>
</html>`;

writeFileSync(resolve(root, "tmp/preview-compare.html"), compare, "utf8");
console.log("written: tmp/preview-before.html / tmp/preview-after.html / tmp/preview-compare.html");
