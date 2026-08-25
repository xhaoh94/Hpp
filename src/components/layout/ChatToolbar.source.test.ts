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

  it("does not expose a previous session model catalog when no models are available", () => {
    expect(toolbarSource).toContain('selectableModels.length > 0 ? (currentModel?.name || "选择模型") : "请先配置渠道"');
    expect(toolbarSource).toContain("availableModels.length > 0 ? includeCurrentModel(availableModels, currentModel) : []");
    expect(panelSource).toContain("availableModels.length > 0 ? includeCurrentModel(availableModels, currentModel) : []");
    expect(toolbarSource).toContain("暂无可用模型。");
  });
});
