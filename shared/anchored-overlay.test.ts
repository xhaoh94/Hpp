import { describe, expect, it } from "vitest";
import { getAnchoredOverlayPosition } from "./anchored-overlay";

describe("getAnchoredOverlayPosition", () => {
  it("centers an overlay on its trigger", () => {
    expect(getAnchoredOverlayPosition(
      { left: 300, top: 500, width: 100, height: 30 },
      { width: 220, height: 200 },
      { width: 900, height: 700 },
    )).toEqual({ left: 240, top: 294 });
  });

  it("keeps a centered overlay inside both viewport edges", () => {
    expect(getAnchoredOverlayPosition(
      { left: 4, top: 300, width: 60, height: 30 },
      { width: 220, height: 120 },
      { width: 320, height: 640 },
    ).left).toBe(12);
    expect(getAnchoredOverlayPosition(
      { left: 286, top: 300, width: 30, height: 30 },
      { width: 220, height: 120 },
      { width: 320, height: 640 },
    ).left).toBe(88);
  });

  it("opens below the trigger when there is not enough room above", () => {
    expect(getAnchoredOverlayPosition(
      { left: 100, top: 20, width: 80, height: 30 },
      { width: 160, height: 120 },
      { width: 360, height: 640 },
    ).top).toBe(56);
  });
});
