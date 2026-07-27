export function getDefaultCloseToTray(platform: string): boolean {
  return platform !== "linux";
}

export function resolveCloseToTraySetting(
  platform: string,
  value: unknown,
  explicitlyConfigured: boolean,
): boolean {
  // Older Linux settings files inherited a true default even when the user
  // never chose it. Require one explicit choice after upgrading.
  if (platform === "linux" && !explicitlyConfigured) return false;
  return typeof value === "boolean" ? value : getDefaultCloseToTray(platform);
}
