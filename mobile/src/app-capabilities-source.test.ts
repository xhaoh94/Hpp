import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "mobile/src/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(process.cwd(), "mobile/src/styles.css"), "utf8");

describe("mobile capability source constraints", () => {
  it("keeps the Agent action picker connected to drafts, sends, and message rendering", () => {
    expect(appSource).toContain('"session.actions.get"');
    expect(appSource).toContain('<WandSparkles size={15} /><span>技能</span>');
    expect(appSource).toContain("actionCount: pendingAction ? 1 : 0");
    expect(appSource).toContain("selectedAction={pendingAction}");
    expect(appSource).toContain("? draft?.action : undefined");
    expect(appSource).toContain("action,");
    expect(appSource).toContain("message.action &&");
  });

  it("uses model-specific thinking levels in the mobile picker", () => {
    expect(appSource).toContain("getModelThinkingLevels(selectedConfig?.model)");
    expect(appSource).toContain("levels={thinkingLevels}");
    expect(appSource).toContain('aria-label="思考等级"');
    expect(appSource).not.toContain("THINKING_LEVELS.map");
  });

  it("shows permission modes before the model picker when the Agent supports them", () => {
    expect(appSource).toContain("selectedAgent?.supportsPermissions === true");
    expect(appSource).toContain("<MobilePermissionPicker");
    expect(appSource).toContain('"settings.setPermissionMode"');
    expect(appSource.indexOf("<MobilePermissionPicker")).toBeLessThan(appSource.indexOf("<MobileModelPicker"));
  });

  it("matches the desktop permission menu colors", () => {
    expect(stylesSource).toContain(".permission-picker-trigger.danger { color: var(--yellow); }");
    expect(stylesSource).toContain(".permission-option.danger b { color: var(--yellow); }");
    expect(stylesSource).toContain(".permission-check { align-self: center; color: var(--accent); }");
    expect(stylesSource).toContain("background: var(--surface);");
  });

  it("keeps queued sends out of the chat until the desktop dispatches them", () => {
    expect(appSource).toContain('const result = await runCommand<{ queued?: boolean }>("session.send"');
    expect(appSource).toContain("queued = result.queued === true");
    expect(appSource).toContain("if (!queued) {");
  });

  it("reloads stale sessions after reconnects and revision gaps", () => {
    expect(appSource).toContain("const staleSessionIdsRef = useRef(new Set<string>())");
    expect(appSource).toContain("staleSessionIdsRef.current.add(sessionId)");
    expect(appSource).toContain("staleSessionIdsRef.current.has(sessionId)");
    expect(appSource).toContain("if (sessionId) void loadSession(sessionId)");
  });

  it("shows feedback after copying a message", () => {
    expect(appSource).toContain('showFloatingToast("已复制")');
    expect(appSource).toContain("onCopy={copyMessage}");
  });

  it("pauses host availability polling while editing a desktop note", () => {
    expect(appSource).toContain("!hostsLoaded || activeHost || editingHostId || hosts.length === 0");
    expect(appSource).toContain("let probing = false");
    expect(appSource).toContain("if (disposed || probing) return;");
  });
});
