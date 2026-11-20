/**
 * 智能压缩阈值：上下文用量到达该百分比时，自动压缩一次上下文。
 * 存百分比而不是绝对 token，一套配置就能适配不同模型的上下文窗口（300K / 1M 各自换算）。
 */

export const CONTEXT_THRESHOLD_MIN = 10;
export const CONTEXT_THRESHOLD_MAX = 95;
/** 默认 80%：既留出余量，又不会在刚聊几轮时就压缩。 */
export const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = 80;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * 归一化阈值：取整并 clamp 到 [10, 95]。
 * 非法值（缺失、非数字、NaN）一律退回默认阈值——这里不做「关闭」语义，
 * 用户想少压把阈值拖高即可。
 */
export function normalizeContextCompactionThreshold(value: unknown): number {
  const raw = typeof value === "number"
    ? value
    : isRecord(value) && typeof value.percent === "number"
      ? value.percent
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
  return Math.round(Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, raw)));
}

/**
 * 用量是否已到达阈值。
 * @param ratio 当前用量比例（usedTokens / contextWindow，0-1 区间）
 * @param thresholdPercent 阈值百分比（如 80 表示 80%）
 */
export function isContextThresholdReached(ratio: number, thresholdPercent: number): boolean {
  if (!Number.isFinite(ratio) || ratio < 0) return false;
  // 浮点除法常给出 79.99999999999999 这类值，留一点容差避免刚好卡在阈值上不触发。
  return ratio * 100 >= normalizeContextCompactionThreshold(thresholdPercent) - 1e-6;
}
