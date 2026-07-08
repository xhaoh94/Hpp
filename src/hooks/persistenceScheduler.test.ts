import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceFlushScheduler } from "./persistenceScheduler";

describe("PersistenceFlushScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resets an existing timer by default", () => {
    vi.useFakeTimers();
    const scheduler = new PersistenceFlushScheduler();
    const first = vi.fn();
    const second = vi.fn();

    scheduler.schedule("projects", 500, first);
    scheduler.schedule("projects", 500, second);

    vi.advanceTimersByTime(499);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(scheduler.has("projects")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(scheduler.has("projects")).toBe(false);
  });

  it("keeps the original timer when reset is false", () => {
    vi.useFakeTimers();
    const scheduler = new PersistenceFlushScheduler();
    const first = vi.fn();
    const second = vi.fn();

    scheduler.schedule("streamingMessages", 8000, first, { reset: false });
    scheduler.schedule("streamingMessages", 8000, second, { reset: false });

    vi.advanceTimersByTime(8000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("clears related timers as a group", () => {
    vi.useFakeTimers();
    const scheduler = new PersistenceFlushScheduler();
    const messages = vi.fn();
    const streamingMessages = vi.fn();
    const models = vi.fn();

    scheduler.schedule("messages", 1000, messages);
    scheduler.schedule("streamingMessages", 8000, streamingMessages);
    scheduler.schedule("models", 500, models);
    scheduler.clearMany(["messages", "streamingMessages"]);

    vi.advanceTimersByTime(8000);
    expect(messages).not.toHaveBeenCalled();
    expect(streamingMessages).not.toHaveBeenCalled();
    expect(models).toHaveBeenCalledTimes(1);
  });

  it("calls default browser timers through globalThis", () => {
    const timer = 1 as ReturnType<typeof setTimeout>;
    const setTimer = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return timer;
    });
    const clearTimer = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
    });
    vi.stubGlobal("setTimeout", setTimer);
    vi.stubGlobal("clearTimeout", clearTimer);

    const scheduler = new PersistenceFlushScheduler();
    scheduler.schedule("projects", 500, vi.fn());
    scheduler.clear("projects");

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledWith(timer);
  });
});
