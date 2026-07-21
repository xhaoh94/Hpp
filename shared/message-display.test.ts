import { describe, expect, it } from "vitest";
import { areAssistantMessageActionsVisible, formatHistoryMessageTime } from "./message-display";

describe("shared message display rules", () => {
  it("shows assistant actions only after both text and process are complete", () => {
    const base = { role: "assistant" as const, content: "done" };
    expect(areAssistantMessageActionsVisible(base)).toBe(true);
    expect(areAssistantMessageActionsVisible({ ...base, isStreaming: true })).toBe(false);
    expect(areAssistantMessageActionsVisible({ ...base, process: {} })).toBe(false);
    expect(areAssistantMessageActionsVisible({ ...base, process: { endedAt: 10 } })).toBe(true);
  });

  it("formats today and earlier history timestamps consistently", () => {
    const now = new Date(2026, 6, 17, 10, 30);
    expect(formatHistoryMessageTime(new Date(2026, 6, 17, 9, 5).getTime(), now)).toMatch(/09:05/);
    expect(formatHistoryMessageTime(new Date(2026, 6, 16, 9, 5).getTime(), now)).toMatch(/^07\/16 /);
  });
});
