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

  it("formats and matches arrow shortcuts without affecting plain arrows", () => {
    const event = { key: "ArrowUp", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    expect(formatShortcut(event)).toBe("Ctrl+Up");
    expect(matchShortcut(event, "Ctrl+Up")).toBe(true);
    expect(matchShortcut({ ...event, ctrlKey: false }, "Ctrl+Up")).toBe(false);
  });
});
