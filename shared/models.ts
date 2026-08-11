export interface SharedModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
  /** 思考档位的呈现模式：levels=有档位声明（下拉）；toggle=仅有思考开关（无档位声明）。 */
  thinkingLevelMode?: "levels" | "toggle";
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
  // “关闭”是 Hpp 的通用思考状态，不要求出现在模型声明/自定义档位列表中。
  // 这样只自定义一个档位（例如 high）的模型仍可通过开关在 off/high 间切换。
  if (normalizedLevel === "off") return "off";
  if (supported.length === 0) return normalizedFallback;
  if (supported.some((candidate) => candidate.id === normalizedLevel)) return normalizedLevel;
  if (supported.some((candidate) => candidate.id === normalizedFallback)) return normalizedFallback;
  return supported.find((candidate) => candidate.id !== "off")?.id || normalizedFallback;
}

/**
 * 返回“思考开关”开启时使用的档位：
 * - 自定义只选 1 档 → 使用该档（如 high）；
 * - 内置无档位声明但提供默认档位 → 优先 medium；
 * - 完全无档位信息 → medium。
 */
export function getThinkingToggleLevel(
  model?: Pick<SharedModel, "supportedThinkingLevels"> | null,
): string {
  const levels = normalizeSupportedThinkingLevels(model?.supportedThinkingLevels)
    .filter((level) => level !== "off");
  if (levels.length === 1) return levels[0];
  if (levels.includes("medium")) return "medium";
  return levels[0] || "medium";
}

/** 判断聊天工具栏提交的思考值是否符合当前模型的显示规则。 */
export function isModelThinkingLevelSelectable(
  model: Pick<SharedModel, "reasoning" | "thinkingLevelMode" | "supportedThinkingLevels"> | null | undefined,
  level: string,
): boolean {
  if (!model?.reasoning) return false;
  const normalizedLevel = normalizeThinkingLevelId(level);
  // off 是 Hpp 通用关闭态，不要求模型档位列表显式声明。
  if (normalizedLevel === "off") return true;
  if (normalizeSupportedThinkingLevels(model.supportedThinkingLevels).includes(normalizedLevel)) return true;
  return getEffectiveThinkingLevelMode(model) === "toggle"
    && normalizedLevel === getThinkingToggleLevel(model);
}

/**
 * 推导思考档位呈现模式：
 * - 非 reasoning 模型 → undefined（不显示思考控件）；
 * - thinkingLevelMode 已由后端（pi worker）设置 → 直接使用；
 * - 非 pi 后端未产出 thinkingLevelMode 时按自定义等级数量推导：
 *   非 off 等级 >1 → levels（下拉），0 或 1 档 → toggle（开关）。
 */
export function getEffectiveThinkingLevelMode(
  model?: Pick<SharedModel, "reasoning" | "thinkingLevelMode" | "supportedThinkingLevels"> | null,
): "levels" | "toggle" | undefined {
  if (!model?.reasoning) return undefined;
  if (model.thinkingLevelMode) return model.thinkingLevelMode;
  const levels = normalizeSupportedThinkingLevels(model.supportedThinkingLevels).filter((l) => l !== "off");
  return levels.length > 1 ? "levels" : "toggle";
}
