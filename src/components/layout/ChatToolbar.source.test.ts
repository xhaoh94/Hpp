import { describe, expect, it } from "vitest";
import toolbarSource from "./ChatToolbar.tsx?raw";

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
});
