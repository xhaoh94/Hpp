import { describe, expect, it } from "vitest";
import { getThemeFromSettings, normalizeAppTheme, resolveAppTheme } from "./theme";

describe("desktop theme settings", () => {
  it("keeps the existing dark theme as the default", () => {
    expect(normalizeAppTheme(undefined)).toBe("dark");
    expect(normalizeAppTheme("unexpected")).toBe("dark");
    expect(getThemeFromSettings({})).toBe("dark");
  });

  it("reads the light theme from general settings", () => {
    expect(getThemeFromSettings({ general: { theme: "light" } })).toBe("light");
  });

  it("supports a system preference that resolves with the OS appearance", () => {
    expect(getThemeFromSettings({ general: { theme: "system" } })).toBe("system");
    expect(resolveAppTheme("system", false)).toBe("light");
    expect(resolveAppTheme("system", true)).toBe("dark");
  });
});
