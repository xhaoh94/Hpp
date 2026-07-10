import { describe, expect, it } from "vitest";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  shouldRunPeriodicAppUpdateCheck,
  shouldStopAppUpdatePolling,
} from "./app-update-polling";

describe("app update polling", () => {
  it("uses a ten minute interval", () => {
    expect(APP_UPDATE_CHECK_INTERVAL_MS).toBe(600_000);
  });

  it("stops polling after an update is found", () => {
    expect(shouldStopAppUpdatePolling("available")).toBe(true);
    expect(shouldStopAppUpdatePolling("downloading")).toBe(true);
    expect(shouldStopAppUpdatePolling("downloaded")).toBe(true);
  });

  it("continues polling after no update or a temporary error", () => {
    expect(shouldRunPeriodicAppUpdateCheck("not-available")).toBe(true);
    expect(shouldRunPeriodicAppUpdateCheck("error")).toBe(true);
    expect(shouldRunPeriodicAppUpdateCheck("checking")).toBe(false);
  });
});
