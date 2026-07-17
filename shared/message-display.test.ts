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
    const now = new Date("2026-07-17T10:30:00+08:00");
    expect(formatHistoryMessageTime(new Date("2026-07-17T09:05:00+08:00").getTime(), now)).toMatch(/09:05/);
    expect(formatHistoryMessageTime(new Date("2026-07-16T09:05:00+08:00").getTime(), now)).toMatch(/^07\/16 /);
  });
});
