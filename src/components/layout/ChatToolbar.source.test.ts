import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import toolbarSource from "./ChatToolbar.tsx?raw";

const panelStyles = readFileSync(
  resolve(process.cwd(), "src/components/layout/ChatPanel.css"),
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

  it("opens the permission menu rightward from the trigger's left edge", () => {
    const rule = panelStyles.match(/\.chat-permission-dropdown\s*\{([^}]*)\}/)?.[1] || "";
    expect(rule).toMatch(/\bleft:\s*0\s*;/);
    expect(rule).not.toMatch(/\bright:\s*0\s*;/);
  });
});
