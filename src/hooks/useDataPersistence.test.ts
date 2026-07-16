import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveSessionModel,
  saveSessionThinking,
  SESSION_CONFIG_UPDATED_EVENT,
} from "./useDataPersistence";

describe("session config change notifications", () => {
  const dispatchEvent = vi.fn();
  const saveData = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    dispatchEvent.mockReset();
    saveData.mockReset();
    vi.stubGlobal("window", { dispatchEvent, electronAPI: { saveData } });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("notifies the remote bridge after saving a session model", () => {
    saveSessionModel("session-model", {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      reasoning: true,
    });

    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ sessionId: string }>;
    expect(event.type).toBe(SESSION_CONFIG_UPDATED_EVENT);
    expect(event.detail).toEqual({ sessionId: "session-model" });
  });

  it("notifies the remote bridge after saving a thinking level", () => {
    saveSessionThinking("session-thinking", "high");

    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ sessionId: string }>;
    expect(event.type).toBe(SESSION_CONFIG_UPDATED_EVENT);
    expect(event.detail).toEqual({ sessionId: "session-thinking" });
  });
});
