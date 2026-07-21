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
  THINKING_LEVELS.find((level) => level.id === levelId)?.label || levelId;

export function getModelThinkingLevels(model?: Pick<SharedModel, "supportedThinkingLevels"> | null) {
  const supported = model?.supportedThinkingLevels;
  if (!supported || supported.length === 0) return [...THINKING_LEVELS];
  const allowed = new Set(supported);
  const levels = THINKING_LEVELS.filter((level) => allowed.has(level.id));
  return levels.length > 0 ? levels : [...THINKING_LEVELS];
}

export function normalizeModelThinkingLevel(
  level: string,
  model?: Pick<SharedModel, "supportedThinkingLevels"> | null,
  fallback = "medium",
) {
  const supported = getModelThinkingLevels(model);
  if (supported.some((candidate) => candidate.id === level)) return level;
  if (supported.some((candidate) => candidate.id === fallback)) return fallback;
  return supported[0]?.id || fallback;
}
