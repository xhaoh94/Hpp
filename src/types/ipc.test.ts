import { describe, expect, it } from "vitest";
import { isAgentEvent, isAppUpdateStatus } from "./ipc";

describe("ipc type guards", () => {
  it("accepts only structured agent events with a non-empty type", () => {
    expect(isAgentEvent({ type: "stream_delta", delta: "hello" })).toBe(true);
    expect(isAgentEvent({ type: "  " })).toBe(false);
    expect(isAgentEvent({ delta: "hello" })).toBe(false);
    expect(isAgentEvent("stream_delta")).toBe(false);
  });

  it("accepts complete app update status payloads", () => {
    expect(isAppUpdateStatus({
      state: "available",
      currentVersion: "1.0.0",
      canCheck: true,
      canDownload: true,
      canInstall: false,
    })).toBe(true);

    expect(isAppUpdateStatus({
      state: "ready",
      currentVersion: "1.0.0",
      canCheck: true,
      canDownload: false,
      canInstall: false,
    })).toBe(false);

    expect(isAppUpdateStatus({
      state: "idle",
      currentVersion: "1.0.0",
      canCheck: true,
      canDownload: false,
    })).toBe(false);
  });
});
