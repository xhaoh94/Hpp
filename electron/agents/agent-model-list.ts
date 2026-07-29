export function combineAgentModels<T extends { provider: string; id: string }>(
  backendModels: T[],
  configuredModels: T[],
  mode: "configured" | "backend" | "merge",
  backendModelsVisible = true,
): T[] {
  const backendByKey = new Map(backendModels.map((model) => [`${model.provider}:${model.id}`, model]));
  const backendById = new Map<string, T | null>();
  for (const model of backendModels) {
    backendById.set(model.id, backendById.has(model.id) ? null : model);
  }
  const enrichConfigured = (model: T): T => {
    const backend = backendByKey.get(`${model.provider}:${model.id}`) || backendById.get(model.id);
    if (!backend) return model;
    const merged = { ...backend, ...model } as T & Record<string, unknown>;
    for (const [key, value] of Object.entries(backend)) {
      if ((model as T & Record<string, unknown>)[key] === undefined) merged[key] = value;
    }
    return merged as T;
  };
  const enrichedConfiguredModels = configuredModels.map(enrichConfigured);

  if (mode === "configured") {
    return enrichedConfiguredModels.length > 0 ? enrichedConfiguredModels : backendModels;
  }
  if (mode === "backend") return backendModels;
  if (!backendModelsVisible) return enrichedConfiguredModels;
  if (configuredModels.length === 0) return backendModels;

  const merged = new Map<string, T>();
  for (const model of backendModels) merged.set(`${model.provider}:${model.id}`, model);
  for (const model of enrichedConfiguredModels) merged.set(`${model.provider}:${model.id}`, model);
  return Array.from(merged.values());
}
