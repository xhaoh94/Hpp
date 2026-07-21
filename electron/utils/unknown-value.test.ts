import { describe, expect, it } from "vitest";
import { asString, getErrorMessage, isRecord } from "./unknown-value";

describe("unknown value helpers", () => {
  it("extracts Error and error-like messages", () => {
    expect(getErrorMessage(new Error("failed"))).toBe("failed");
    expect(getErrorMessage({ message: "rejected" })).toBe("rejected");
    expect(getErrorMessage({ message: 404 })).toBe("[object Object]");
  });

  it("recognizes records without accepting arrays or null", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("returns trimmed strings and rejects other values", () => {
    expect(asString("  value  ")).toBe("value");
    expect(asString(123)).toBe("");
  });
});
