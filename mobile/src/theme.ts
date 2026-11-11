export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "hpp-mobile-theme";

export const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: "#1e1e1e",
  light: "#f7f7f8",
};

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function loadThemePreference(): ThemePreference {
  try {
    return parseThemePreference(globalThis.localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function saveThemePreference(value: ThemePreference) {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, parseThemePreference(value));
  } catch {
    // 禁用存储时仍保留本次会话已解析的主题。
  }
}

export function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[resolved]);
}
