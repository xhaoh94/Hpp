/**
 * 智能压缩档位：一组上下文用量百分比（如 [50, 70, 90]）。
 * 用量（usedTokens / contextWindow）越过某档、且当前回合结束时，Hpp 自动触发一次压缩；
 * 压缩后用量回落，下次再涨到该档可再次触发（每档可重复使用）。
 */

export const CONTEXT_TIER_MIN = 10;
export const CONTEXT_TIER_MAX = 95;
export const CONTEXT_TIER_LIMIT = 5;
export const DEFAULT_CONTEXT_COMPACTION_TIERS: number[] = [70, 90];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 归一化档位：只留数值、clamp 到 [10,95]、去重、升序、最多 5 档。 */
export function normalizeContextCompactionTiers(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  const tiers = list
    .map((item) => typeof item === "number" ? item : (isRecord(item) ? item.percent : undefined))
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    .map((item) => Math.round(Math.min(CONTEXT_TIER_MAX, Math.max(CONTEXT_TIER_MIN, item))))
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort((a, b) => a - b)
    .slice(0, CONTEXT_TIER_LIMIT);
  return tiers;
}

/**
 * 判断用量是否越过某档，返回被越过的档位；没越过返回 null。
 * @param ratio 当前用量比例（0-1）
 * @param previousRatio 上次记录的比例（0-1），用于避免同一档反复触发
 * @param tiers 归一化后的档位百分比数组
 */
export function crossedCompactionTier(ratio: number, previousRatio: number, tiers: number[]): number | null {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1.5) return null;
  if (!Number.isFinite(previousRatio)) return null;
  const currentPercent = ratio * 100;
  const previousPercent = previousRatio * 100;
  // 从低到高找第一个「上次在档位以下、这次到了档位以上」的档，取最高的那个。
  let crossed: number | null = null;
  for (const tier of tiers) {
    if (previousPercent < tier && currentPercent >= tier) crossed = tier;
  }
  return crossed;
}
