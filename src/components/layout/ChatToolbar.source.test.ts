import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import toolbarSource from "./ChatToolbar.tsx?raw";

const panelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
  "utf8",
);
const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.tsx"),
  "utf8",
);

describe("chat toolbar permission selector", () => {
  it("renders the permission control immediately before the model selector", () => {
    const permissionIndex = toolbarSource.indexOf('ref={permissionRef}');
    const modelIndex = toolbarSource.indexOf('ref={modelRef}');
    const thinkingIndex = toolbarSource.indexOf('ref={thinkingRef}');
    expect(permissionIndex).toBeGreaterThan(-1);
    expect(modelIndex).toBeGreaterThan(permissionIndex);
    expect(thinkingIndex).toBeGreaterThan(modelIndex);
    expect(toolbarSource.slice(permissionIndex, modelIndex)).not.toContain('ref={thinkingRef}');
  });

  it("offers all three modes and warns on full access", () => {
    expect(toolbarSource).toContain("{permissionModeSupported && <div");
    expect(toolbarSource).toContain('onPermissionModeChange("ask")');
    expect(toolbarSource).toContain('onPermissionModeChange("auto")');
    expect(toolbarSource).toContain('onPermissionModeChange("full-access")');
    expect(toolbarSource).toContain("完全访问权限");
    expect(toolbarSource).toContain('chat-permission-option danger');
  });

  it("centers all selector menus on their triggers without clipping at viewport edges", () => {
    expect(toolbarSource.match(/useAnchoredOverlay\(/g)).toHaveLength(3);
    expect(toolbarSource.match(/createPortal\(/g)).toHaveLength(3);
    expect(toolbarSource).toContain("data-chat-toolbar-overlay");
    expect(panelSource).toContain('closest?.("[data-chat-toolbar-overlay]")');
    expect(panelStyles).toContain(".chat-permission-dropdown");
  });

  it("never scrolls the model list on hover", () => {
    // 悬浮只移动光标，不滚动：以前 cursor 一变就 scrollIntoView，鼠标划过
    // 相邻行时列表和外层对话区都会自己滚一下。
    expect(toolbarSource).not.toContain(".scrollIntoView(");
    expect(toolbarSource).toContain("modelCursorScrollRef");
    // 键盘移动才置位，悬浮顺手清掉残留标记。
    expect(toolbarSource).toContain("modelCursorScrollRef.current = true");
    expect(toolbarSource).toContain("modelCursorScrollRef.current = false");
    // 只动下拉自己的 scrollTop，不碰祖先容器。
    expect(toolbarSource).toContain("container.scrollTop = rowBottom - container.clientHeight");
  });

  it("labels model groups with the provider display name, not the internal id", () => {
    // 一级标题给人看的是渠道名；id 只在拿不到名字时兜底。
    expect(toolbarSource).toContain("{providerNames[provider] || provider}");
    expect(panelSource).toContain("provider.displayName || provider.providerId");
    expect(panelSource).toContain("providerNames={modelProviderNames}");
  });

  it("does not expose a previous session model catalog when no models are available", () => {
    expect(toolbarSource).toContain('selectableModels.length > 0 ? (currentModel?.name || "选择模型") : "请先配置渠道"');
    expect(toolbarSource).toContain("availableModels.length > 0 ? includeCurrentModel(availableModels, currentModel) : []");
    expect(panelSource).toContain("availableModels.length > 0 ? includeCurrentModel(availableModels, currentModel) : []");
    expect(toolbarSource).toContain("暂无可用模型。");
  });
});
