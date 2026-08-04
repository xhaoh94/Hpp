import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  matchShortcut,
  normalizeShortcuts,
} from "./shortcuts";

describe("desktop shortcuts", () => {
  it("fills message navigation defaults into legacy settings", () => {
    expect(normalizeShortcuts({ sendKey: "Ctrl+Enter", cycleModel: "Ctrl+M" })).toEqual({
      ...DEFAULT_SHORTCUTS,
      sendKey: "Ctrl+Enter",
    });
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
