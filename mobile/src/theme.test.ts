import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THEME_COLOR,
  THEME_STORAGE_KEY,
  applyTheme,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
} from "./theme";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("mobile theme preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to system for unknown stored values", () => {
    expect(parseThemePreference(undefined)).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("solarized")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("resolves system preference from the OS while explicit choices win", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("persists and reloads the preference", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    });

    expect(loadThemePreference()).toBe("system");
    saveThemePreference("light");
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
    expect(loadThemePreference()).toBe("light");

    saveThemePreference("dark");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(loadThemePreference()).toBe("dark");
  });

  it("tolerates storage being unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadThemePreference()).toBe("system");
    expect(() => saveThemePreference("dark")).not.toThrow();
  });

  it("applies the resolved theme to the document and status bar color", () => {
    const setAttribute = vi.fn();
    const root: { dataset: Record<string, string>; style: Record<string, string> } = {
      dataset: {},
      style: {},
    };
    vi.stubGlobal("document", {
      documentElement: root,
      querySelector: () => ({ setAttribute }),
    });

    applyTheme("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(setAttribute).toHaveBeenCalledWith("content", THEME_COLOR.light);

    applyTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(setAttribute).toHaveBeenCalledWith("content", THEME_COLOR.dark);
  });
});

describe("mobile theme wiring", () => {
  it("defines both palettes and applies the choice before first paint", () => {
    const css = readWorkspaceFile("mobile/src/styles.css");
    const html = readWorkspaceFile("mobile/index.html");
    const app = readWorkspaceFile("mobile/src/App.tsx");

    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain("--bg: #f7f7f8");
    expect(css).toContain("color-scheme: light");
    expect(html).toContain("hpp-mobile-theme");
    expect(html).toContain("dataset.theme = theme");
    expect(app).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(app).toContain("resolveTheme(themePreference, media.matches)");
  });
});
