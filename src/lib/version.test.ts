import { describe, expect, it } from "vitest";
import { compareVersions, isValidVersion, meetsMinimumVersion } from "./version";

describe("version helpers", () => {
  it("compares numeric versions with optional v prefixes", () => {
    expect(compareVersions("v1.2.3", "1.2.2")).toBeGreaterThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("orders prerelease versions before stable releases", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  });

  it("validates and checks minimum versions", () => {
    expect(isValidVersion("0.0.1")).toBe(true);
    expect(isValidVersion("latest")).toBe(false);
    expect(meetsMinimumVersion("0.0.1", "0.0.1")).toBe(true);
    expect(meetsMinimumVersion("0.0.1", "0.0.2")).toBe(false);
  });
});
