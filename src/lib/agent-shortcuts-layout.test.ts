import { describe, expect, it } from "vitest";
import { calculateVisibleAgentCount } from "./agent-shortcuts-layout";

describe("agent shortcut layout", () => {
  it("shows every shortcut when they fit without an overflow button", () => {
    expect(calculateVisibleAgentCount([40, 60, 80], 188, 24, 4)).toBe(3);
  });

  it("reserves room for the overflow button when only part of the list fits", () => {
    expect(calculateVisibleAgentCount([40, 60, 80], 132, 24, 4)).toBe(2);
    expect(calculateVisibleAgentCount([40, 60, 80], 60, 24, 4)).toBe(0);
  });

  it("handles an empty or unavailable container", () => {
    expect(calculateVisibleAgentCount([], 200, 24, 4)).toBe(0);
    expect(calculateVisibleAgentCount([40], 0, 24, 4)).toBe(0);
  });
});
