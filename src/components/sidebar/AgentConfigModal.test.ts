import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfigState, AgentProviderConfig } from "@/types";
import { resolveModelDropIndex, resolvePreferredProviderId } from "./AgentConfigModal";

const modalSource = readFileSync(resolve(process.cwd(), "src/components/sidebar/AgentConfigModal.tsx"), "utf8");
const settingsStyles = readFileSync(resolve(process.cwd(), "src/components/sidebar/Settings.css"), "utf8");

const provider = (providerId: string): AgentProviderConfig => ({
  providerId,
  displayName: providerId,
  baseUrl: `https://${providerId}.example/v1`,
  apiKey: "key",
  endpoint: "responses",
  models: [{ id: `${providerId}-model`, name: providerId, reasoning: true, imageInput: false }],
});

describe("AgentConfigModal provider selection", () => {
  const state: AgentConfigState = {
    activeProviderId: "ylk",
    providers: [provider("ylk"), provider("wanzi"), provider("pixel")],
  };

  it("selects the current model provider before the active or first provider", () => {
    expect(resolvePreferredProviderId(state, "pixel")).toBe("pixel");
  });

  it("falls back to the active provider and then the first provider", () => {
    expect(resolvePreferredProviderId(state, "missing")).toBe("ylk");
    expect(resolvePreferredProviderId({ providers: state.providers }, "missing")).toBe("ylk");
  });

  it("mounts above the Agent settings dialog when opened from its header", () => {
    expect(modalSource).toContain('import { createPortal } from "react-dom";');
    expect(modalSource).toContain("return createPortal(");
    expect(modalSource).toContain('className="settings-modal-overlay agent-config-modal-overlay"');
    expect(settingsStyles).toContain(".agent-config-modal-overlay {");
    expect(settingsStyles).toContain("z-index: 1050;");
  });

  it("lays out URL like the other summary fields and adapts columns automatically", () => {
    expect(modalSource).toContain('<span>渠道 URL</span>');
    expect(modalSource).toContain('<div className="agent-config-summary-row">');
    expect(modalSource).not.toContain('className="agent-config-summary-row wide"');
    expect(settingsStyles).toContain("grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));");
    expect(settingsStyles).not.toContain(".agent-config-summary-row.wide");
  });

  it("does not repeat the model count as a summary card", () => {
    // 「模型」标题旁边已经有数量徽标，摘要区再放一张模型数量卡片就是重复信息。
    expect(modalSource).not.toContain("模型数量");
    expect(modalSource).toContain('className="agent-config-count"');
  });

  it("keeps 渠道 URL and Endpoint on the same form row in the provider editor", () => {
    // 摘要区也有「渠道 URL」，所以断言要落在编辑弹窗的源码片段里。
    const editorStart = modalSource.indexOf("agent-provider-editor-content");
    const editorSource = modalSource.slice(editorStart, modalSource.indexOf("agent-config-models-panel", editorStart));
    const urlIndex = editorSource.indexOf("<span>渠道 URL</span>");
    expect(urlIndex).toBeGreaterThan(-1);
    const labelIndex = editorSource.lastIndexOf("<label", urlIndex);
    // 不宽占整行，URL 才能和紧跟其后的 Endpoint 落在同一个栅格行。
    expect(editorSource.slice(labelIndex, editorSource.indexOf(">", labelIndex) + 1)).toBe("<label>");
    expect(settingsStyles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
  });

  it("drops the 凭据 group label and keeps sk-key a full-width field", () => {
    expect(modalSource).not.toContain("凭据");
    const keyIndex = modalSource.indexOf("<span>sk-key</span>");
    const labelIndex = modalSource.lastIndexOf("<label", keyIndex);
    expect(modalSource.slice(labelIndex, modalSource.indexOf(">", labelIndex) + 1)).toBe('<label className="agent-config-field-wide">');
  });

  it("keeps the selected channel summary fixed while only the model list scrolls", () => {
    const formStyles = settingsStyles.slice(
      settingsStyles.indexOf(".agent-config-form {"),
      settingsStyles.indexOf(".agent-config-provider-scroll {"),
    );
    const modelListStyles = settingsStyles.slice(
      settingsStyles.indexOf(".agent-config-summary-model-list {"),
      settingsStyles.indexOf(".agent-config-summary-model {"),
    );
    expect(modalSource).toContain('className="agent-config-summary-model-list"');
    expect(formStyles).toContain("display: flex;");
    expect(formStyles).toContain("overflow: hidden;");
    expect(modelListStyles).toContain("overflow-y: auto;");
    expect(modelListStyles).toContain("overflow-x: hidden;");
  });

  it("uses a dedicated drag handle and preserves the source across Electron drag/drop timing", () => {
    expect(modalSource).toContain('className="agent-config-provider-drag"');
    expect(modalSource).toContain('className={`agent-config-provider-item ${selected ? "selected" : ""} ${active ? "active" : ""} ${dragging ? "dragging" : ""} ${dropTarget ? `drop-target ${dragOverProviderPosition}` : ""} ${reordering ? "reordering" : ""}`}');
    expect(modalSource).toContain('draggable={config.providers.length > 1 && !reorderingProviderId}');
    expect(modalSource).toContain("const dragProviderIdRef = useRef(\"\")");
    expect(modalSource).toContain("const sourceProviderId = event.dataTransfer.getData(\"text/plain\")");
    expect(modalSource).toContain("|| dragProviderIdRef.current");
    expect(modalSource).toContain("const commitProviderReorder = useCallback");
    expect(modalSource).toContain("某些 Electron 场景只派发 dragend，不派发 drop");
    expect(modalSource).toContain("if (sourceProviderId && targetProviderId && !dragReorderCommittedRef.current)");
    expect(modalSource).toContain("if (!result.config) {");
    expect(modalSource).toContain("渠道顺序已保存，但");
    expect(modalSource).toContain("event.preventDefault();");
    expect(modalSource).toContain('event.dataTransfer.dropEffect = "move"');
  });

  it("keeps the thinking-level dropdown compact", () => {
    const start = settingsStyles.indexOf(".agent-thinking-multiselect {");
    const rule = settingsStyles.slice(start, settingsStyles.indexOf("}", start));
    // 档位文本很短：固定紧凑宽度，不再吃满整列。
    expect(rule).toContain("flex: 0 0 auto");
    expect(rule).toContain("width: 112px");
  });

  it("left-aligns the column labels and keeps the ability column right-aligned", () => {
    const labelStart = settingsStyles.indexOf(".agent-config-model-head-label {");
    const labelRule = settingsStyles.slice(labelStart, settingsStyles.indexOf("}", labelStart));
    // 左对齐并留出输入框的内边距：标题与下方输入内容对齐成表头。
    expect(labelRule).toContain("text-align: left");
    const checksStart = settingsStyles.indexOf(".agent-config-model-checks {");
    const checksRule = settingsStyles.slice(checksStart, settingsStyles.indexOf("}", checksStart));
    expect(checksRule).toContain("justify-content: flex-end");
  });

  it("hides the model list scrollbar", () => {
    expect(settingsStyles).toContain("scrollbar-width: none");
    expect(settingsStyles).toContain("-webkit-scrollbar");
  });

  it("computes the reordered index for a dragged model row", () => {
    // 前移：把第 4 行拖到第 1 行之前 → 最终位置 0。
    expect(resolveModelDropIndex(3, 0, "before")).toBe(0);
    // 后移：把第 1 行拖到第 3 行之后 → 删原位后插入点前移 → 位置 2。
    expect(resolveModelDropIndex(0, 2, "after")).toBe(2);
    expect(resolveModelDropIndex(1, 0, "before")).toBe(0);
    expect(resolveModelDropIndex(0, 1, "after")).toBe(1);
    // 拖到自己下半区 → 向后一位（仍会变化）；上半区 → 原地不动。
    expect(resolveModelDropIndex(0, 0, "after")).toBe(1);
    expect(resolveModelDropIndex(0, 0, "before")).toBe(0);
  });

  it("reorders models by dragging a dedicated handle", () => {
    expect(modalSource).toContain('className="agent-config-model-drag"');
    expect(modalSource).toContain("onDragStart={(event) => handleModelDragStart(event, index)}");
    expect(modalSource).toContain("onDrop={(event) => commitModelDrop(event, index)}");
    // 拖动状态用 ref 同步：dragstart → dragover 可能同一帧，state 还没生效。
    expect(modalSource).toContain("const dragModelIndexRef = useRef<number | null>(null)");
    expect(modalSource).toContain("if (dragModelIndexRef.current === null) return;");
    expect(modalSource).toContain('Number(event.dataTransfer.getData("text/plain"))');
    // Electron 可能只派发 dragend 不派发 drop：dragend 里要补一次提交。
    expect(modalSource).toContain("onDragEnd={handleModelDragEnd}");
    expect(modalSource).toContain("if (!modelDropCommittedRef.current) {");
    // 拖动反馈：拖起行半透明，目标行显示插入线。
    expect(settingsStyles).toContain(".agent-config-model-row.drop-before");
    expect(settingsStyles).toContain(".agent-config-model-row.dragging");
  });

  it("labels the model id and display name columns on the toolbar row", () => {
    // 列标题与“获取模型/添加模型”同一行，不再单独占一行，也没有“能力”说明。
    expect(modalSource).toContain('className="agent-config-model-head-label">模型 ID<');
    expect(modalSource).toContain('className="agent-config-model-head-label">显示名<');
    expect(modalSource).not.toContain("agent-config-model-head-ability");
    // 面板左上角不再有单独的“模型”标题（它现在与列标题、按钮同排）。
    const panelHeaderStart = modalSource.indexOf("agent-config-models-header");
    const panelHeaderBlock = modalSource.slice(
      panelHeaderStart,
      modalSource.indexOf("agent-config-model-actions", panelHeaderStart),
    );
    expect(panelHeaderBlock).not.toContain("agent-config-section-title");
    expect(panelHeaderBlock).toContain("模型 ID");
    expect(modalSource).toContain('placeholder="model-id"');
    expect(modalSource).toContain('placeholder="显示名（默认同 ID）"');
    expect(modalSource).toContain('className="input-field agent-config-model-display-name"');
    // 内置行的显示名跨过空能力列，保留 ID 宽度。
    expect(settingsStyles).toContain(".agent-config-model-row.builtin > .agent-config-model-display-name");
    // 内置行不渲染能力区占位（占位会抢走删除列，把删除按钮挤到隐式第二行）。
    expect(modalSource).not.toContain('className="agent-config-model-checks" aria-hidden="true" />');
    // 删除按钮显式钉在最后一列，不依赖自动排布。
    expect(settingsStyles).toContain(".agent-config-model-row > .btn-delete {");
    expect(settingsStyles).toContain("grid-column: 5;");
    expect(settingsStyles).toContain("--agent-model-columns");
    expect(settingsStyles).toContain(".agent-config-model-head-label");
    // 列标题与按钮同行：按钮跨能力+删除列并靠右。
    expect(settingsStyles).toContain(".agent-config-models-header .agent-config-model-actions");
  });

  it("keeps the channel detail header out of the model column grid", () => {
    // 渠道头部曾经和模型表头共用一条 grid 规则，而 --agent-model-columns 只定义在模型面板上，
    // 变量取不到 → grid-template-columns 失效 → 标题和编辑/复制/删除按钮错位换行。
    expect(settingsStyles).not.toContain(".agent-config-form-header,\n.agent-config-models-header");
    expect(settingsStyles).toContain(".agent-config-form-header {");
    expect(settingsStyles).toContain(".agent-config-form-caption");
    // 头部显示渠道名 + ID，头部右上是次级操作按钮。
    expect(modalSource).toContain('className="agent-config-form-caption"');
    expect(modalSource).toContain("agent-config-danger-btn");
  });

  it("clears the saving state after saving so the button cannot stick", () => {
    const saveStart = modalSource.indexOf("const handleSaveProvider");
    const saveBlock = modalSource.slice(saveStart, modalSource.indexOf("// Ctrl+S / Cmd+S", saveStart));
    // 无条件重置：保存成功后会调用 loadConfig()，它会自增 editorScope，
    // 若把重置放在 scope 判断里，按钮会永远停在“保存中...”。
    expect(saveBlock).toContain("setSavingProvider(false);");
    expect(saveBlock).not.toContain("if (scope === editorScope.current) setSavingProvider(false);");
    // 打开编辑器（新增/编辑）时也重置一次，避免上一次的残留。
    const editStart = modalSource.indexOf("const handleEditProvider");
    const editBlock = modalSource.slice(editStart, modalSource.indexOf("const handleOpenProviderCopy", editStart));
    expect(editBlock).toContain("setSavingProvider(false);");
  });

  it("gives the display-name column more room than the id column", () => {
    // 显示名列比 ID 列宽，把能力列右侧的空白吃掉。
    expect(settingsStyles).toContain("minmax(0, 1.45fr)");
    expect(settingsStyles).toContain("--agent-model-columns: 22px minmax(0, 1fr) minmax(0, 1.45fr)");
  });

  it("saves the channel draft on demand and refreshes afterwards", () => {
    // 主动保存：保存按钮 + Ctrl+S，而不是已经移除的自动保存。
    expect(modalSource).toContain('title="保存渠道（Ctrl+S）"');
    expect(modalSource).toContain('event.key.toLowerCase() !== "s"');
    expect(modalSource).toContain("void handleSaveProvider();");
    expect(modalSource).not.toContain("autoSaveTimer");
    expect(modalSource).not.toContain("performAutoSave");
    // 保存后刷新渠道列表与模型目录，并弹提示。
    expect(modalSource).toContain("void loadConfig();");
    expect(modalSource).toContain('showFloatingToastMessage("渠道已保存")');
    // 取消时丢弃未保存改动要有提示。
    expect(modalSource).toContain("已放弃未保存的渠道改动");
    expect(settingsStyles).toContain(".agent-config-dirty-hint");
  });

  it("refreshes the channel list and model catalogue after an import", () => {
    expect(modalSource).toContain("<AgentConfigIO onImported={handleProvidersImported} />");
    expect(modalSource).toContain("const handleProvidersImported = useCallback((importedAgentIds: string[]) => {");
    expect(modalSource).toContain("if (importedAgentIds.includes(agentId)) {");
    expect(modalSource).toContain("void loadConfig();");
    expect(modalSource).toContain("await window.electronAPI.agentGetModels()");
    expect(modalSource).toContain("onModelsUpdated(agentId, models)");
  });
});
