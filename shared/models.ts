export interface SharedModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}

export const THINKING_LEVELS = [
  { id: "off", label: "关闭" },
  { id: "minimal", label: "最低" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "极高" },
  { id: "max", label: "最高" },
  { id: "ultra", label: "超强" },
] as const;

export const isSameModel = (
  left: Pick<SharedModel, "id" | "provider"> | null | undefined,
  right: Pick<SharedModel, "id" | "provider"> | null | undefined,
) => !!left && !!right && left.id === right.id && left.provider === right.provider;

export function groupModelsByProvider<T extends Pick<SharedModel, "provider">>(models: T[]) {
  const grouped = new Map<string, T[]>();
  for (const model of models) {
    const providerModels = grouped.get(model.provider);
    if (providerModels) providerModels.push(model);
    else grouped.set(model.provider, [model]);
  }
  return grouped;
}

export function getOrderedModelProviders<T extends Pick<SharedModel, "provider">>(
  models: T[],
  preferredOrder: string[] = [],
) {
  const providers = [...new Set(models.map((model) => model.provider))];
  if (preferredOrder.length === 0) return providers;
  const originalIndex = new Map(providers.map((provider, index) => [provider, index]));
  const orderedIndex = new Map(preferredOrder.map((provider, index) => [provider, index]));
  return providers.slice().sort((left, right) => {
    const leftOrder = orderedIndex.get(left);
    const rightOrder = orderedIndex.get(right);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    }
    return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0);
  });
}

export function includeCurrentModel<T extends SharedModel>(models: T[], current?: T | null) {
  if (!current || models.some((model) => isSameModel(model, current))) return [...models];
  return [current, ...models];
}

export const getThinkingLevelLabel = (levelId: string) =>
  THINKING_LEVELS.find((level) => level.id === normalizeThinkingLevelId(levelId))?.label || levelId;

export function normalizeThinkingLevelId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none") return "off";
  return normalized;
}

export function normalizeSupportedThinkingLevels(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const levels: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const level = normalizeThinkingLevelId(value);
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

export function getModelThinkingLevels(model?: Pick<SharedModel, "supportedThinkingLevels"> | null) {
  return normalizeSupportedThinkingLevels(model?.supportedThinkingLevels).map((id) => ({
    id,
    label: getThinkingLevelLabel(id),
  }));
}

export function normalizeModelThinkingLevel(
  level: string,
  model?: Pick<SharedModel, "supportedThinkingLevels"> | null,
  fallback = "medium",
) {
  const supported = getModelThinkingLevels(model);
  const normalizedLevel = normalizeThinkingLevelId(level);
  const normalizedFallback = normalizeThinkingLevelId(fallback);
  if (supported.length === 0) return normalizedFallback;
  if (supported.some((candidate) => candidate.id === normalizedLevel)) return normalizedLevel;
  if (supported.some((candidate) => candidate.id === normalizedFallback)) return normalizedFallback;
  return supported[0]?.id || normalizedFallback;
}
