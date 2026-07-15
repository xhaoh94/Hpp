export function combineAgentModels<T extends { provider: string; id: string }>(
  backendModels: T[],
  configuredModels: T[],
  mode: "configured" | "backend" | "merge",
  backendModelsVisible = true,
): T[] {
  if (mode === "configured") {
    return configuredModels.length > 0 ? configuredModels : backendModels;
  }
  if (mode === "backend") return backendModels;
  if (!backendModelsVisible) return configuredModels;
  if (configuredModels.length === 0) return backendModels;

  const merged = new Map<string, T>();
  for (const model of backendModels) merged.set(`${model.provider}:${model.id}`, model);
  for (const model of configuredModels) merged.set(`${model.provider}:${model.id}`, model);
  return Array.from(merged.values());
}
