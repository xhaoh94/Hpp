import { describe, expect, it } from "vitest";
import { getDefaultCloseToTray, resolveCloseToTraySetting } from "./desktop-platform";

describe("desktop platform defaults", () => {
  it("does not hide the only window by default on Linux", () => {
    expect(getDefaultCloseToTray("linux")).toBe(false);
  });

  it("preserves close-to-tray defaults on other desktop platforms", () => {
    expect(getDefaultCloseToTray("win32")).toBe(true);
    expect(getDefaultCloseToTray("darwin")).toBe(true);
  });

  it("migrates inherited Linux settings but preserves an explicit opt-in", () => {
    expect(resolveCloseToTraySetting("linux", true, false)).toBe(false);
    expect(resolveCloseToTraySetting("linux", true, true)).toBe(true);
    expect(resolveCloseToTraySetting("linux", false, true)).toBe(false);
  });

  it("preserves existing settings on other platforms", () => {
    expect(resolveCloseToTraySetting("win32", false, false)).toBe(false);
    expect(resolveCloseToTraySetting("darwin", undefined, false)).toBe(true);
  });
});
