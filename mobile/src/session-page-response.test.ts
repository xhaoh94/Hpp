import { describe, expect, it } from "vitest";
import { isSessionPageResponseCurrent } from "./App";

describe("mobile session page response ordering", () => {
  it("accepts a page that includes every delivered revision", () => {
    expect(isSessionPageResponseCurrent(8, 8, 2, 2)).toBe(true);
    expect(isSessionPageResponseCurrent(9, 8, 2, 2)).toBe(true);
  });

  it("rejects a page older than an event already delivered to the client", () => {
    expect(isSessionPageResponseCurrent(7, 8, 2, 2)).toBe(false);
  });

  it("rejects a page when an unrevisioned event arrived during the request", () => {
    expect(isSessionPageResponseCurrent(8, 8, 2, 3)).toBe(false);
  });
});
