import { describe, expect, it } from "vitest";
import { resolvePreviousUserTargetIndex } from "./previousUserTarget";

describe("resolvePreviousUserTargetIndex", () => {
  const speechIndexes = [0, 3, 7];

  it("returns the latest user speech when the viewport is below all messages", () => {
    expect(resolvePreviousUserTargetIndex(speechIndexes, null, 9)).toBe(7);
  });

  it("returns the current turn user speech while viewing its assistant response", () => {
    expect(resolvePreviousUserTargetIndex(speechIndexes, null, 8)).toBe(7);
    expect(resolvePreviousUserTargetIndex(speechIndexes, null, 5)).toBe(3);
  });

  it("moves to the preceding speech when a user bubble is visible", () => {
    expect(resolvePreviousUserTargetIndex(speechIndexes, 7, 7)).toBe(3);
    expect(resolvePreviousUserTargetIndex(speechIndexes, 3, 3)).toBe(0);
  });

  it("hides the button when the first user speech is visible", () => {
    expect(resolvePreviousUserTargetIndex(speechIndexes, 0, 0)).toBeNull();
  });

  it("does not guess a target before the viewport position is known", () => {
    expect(resolvePreviousUserTargetIndex(speechIndexes, null, null)).toBeNull();
  });
});
