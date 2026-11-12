import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  matchShortcut,
  normalizeSendKey,
  normalizeShortcuts,
} from "./shortcuts";

describe("desktop shortcuts", () => {
  it("fills message navigation defaults into legacy settings", () => {
    expect(normalizeShortcuts({ sendKey: "normal", cycleModel: "Ctrl+M" })).toEqual({
      ...DEFAULT_SHORTCUTS,
      sendKey: "normal",
    });
  });

  it("migrates legacy sendKey values to the normal/guide modes", () => {
    // 旧配置「Ctrl+Enter 发送」在新语义下 = Ctrl+Enter 普通发送、Enter 引导。
    expect(normalizeSendKey("Ctrl+Enter")).toBe("guide");
    expect(normalizeSendKey("Enter")).toBe("normal");
    // 非法值落回默认。
    expect(normalizeSendKey("whatever")).toBe("normal");
    expect(normalizeSendKey(undefined)).toBe("normal");
  });

  it("uses Ctrl+arrow keys for message navigation by default", () => {
    const event = { key: "ArrowUp", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    expect(formatShortcut(event)).toBe("Ctrl+Up");
    expect(matchShortcut(event, DEFAULT_SHORTCUTS.previousMessage)).toBe(true);
    expect(matchShortcut({ ...event, ctrlKey: false }, DEFAULT_SHORTCUTS.previousMessage)).toBe(false);
  });

  it("keeps user-configured message navigation shortcuts", () => {
    expect(normalizeShortcuts({ previousMessage: "Ctrl+Up", nextMessage: "Ctrl+Down" })).toMatchObject({
      previousMessage: "Ctrl+Up",
      nextMessage: "Ctrl+Down",
    });
    expect(normalizeShortcuts({ previousMessage: "Alt+Up", nextMessage: "Alt+Down" })).toMatchObject({
      previousMessage: "Alt+Up",
      nextMessage: "Alt+Down",
    });
  });
});
