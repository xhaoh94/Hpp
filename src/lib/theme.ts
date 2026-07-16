export type AppTheme = "system" | "light" | "dark";
export type ResolvedAppTheme = "light" | "dark";

export const DEFAULT_APP_THEME: AppTheme = "dark";
export const APP_THEME_STORAGE_KEY = "hpp:desktop-theme";

let removeSystemThemeListener: (() => void) | null = null;

export function normalizeAppTheme(value: unknown): AppTheme {
  return value === "system" || value === "light" ? value : DEFAULT_APP_THEME;
}

export function resolveAppTheme(theme: AppTheme, systemPrefersDark: boolean): ResolvedAppTheme {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

export function getThemeFromSettings(value: unknown): AppTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_APP_THEME;
  const settings = value as Record<string, unknown>;
  const general = settings.general;
  if (!general || typeof general !== "object" || Array.isArray(general)) return DEFAULT_APP_THEME;
  return normalizeAppTheme((general as Record<string, unknown>).theme);
}

export function getStoredThemeHint(): AppTheme {
  try {
    return normalizeAppTheme(window.localStorage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_THEME;
  }
}

export function applyAppTheme(theme: AppTheme): void {
  removeSystemThemeListener?.();
  removeSystemThemeListener = null;

  const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const updateResolvedTheme = () => {
    const resolvedTheme = resolveAppTheme(theme, mediaQuery?.matches === true);
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themePreference = theme;
    document.documentElement.style.colorScheme = resolvedTheme;
  };

  updateResolvedTheme();
  if (theme === "system" && mediaQuery) {
    mediaQuery.addEventListener("change", updateResolvedTheme);
    removeSystemThemeListener = () => mediaQuery.removeEventListener("change", updateResolvedTheme);
  }
  try {
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
  } catch {
    // The persisted settings remain authoritative if local storage is unavailable.
  }
}
