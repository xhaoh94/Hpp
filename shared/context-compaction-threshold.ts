/**
 * 智能压缩阈值：上下文用量到达该百分比时，自动压缩一次上下文。
 * 存百分比而不是绝对 token，一套配置就能适配不同模型的上下文窗口（300K / 1M 各自换算）。
 *
 * 阈值按「渠道 + 模型」分别保存：不同模型的窗口大小、计费与压缩代价差别很大，
 * 一个全局百分比会让某个模型在很低的用量就被压掉。键为 `provider:id`，
 * 与模型选择器、思考档位缓存的口径一致。
 *
 * 触发由 Hpp 主进程统一判定（见 electron/agents/context-compaction-controller.ts），
 * 各 Agent 只用自己已有的 compact() 接口，不再改写各自的自动压缩配置。
 */

export const CONTEXT_THRESHOLD_MIN = 10;
/**
 * 上限 100%：滑块拉到最右就是「不按阈值自动压缩」，也是默认值。
 * 压缩要花一次摘要请求、还会改写上下文，这个代价不该由用户不知情地承担：
 * 需要提前压的人在弹窗里按模型显式调低即可。
 */
export const CONTEXT_THRESHOLD_MAX = 100;
/** 默认 100%：没配置过的模型默认不自动压缩。 */
export const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = CONTEXT_THRESHOLD_MAX;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** settings.general 里按「渠道 + 模型」保存阈值的字段名。 */
export const CONTEXT_COMPACTION_THRESHOLDS_KEY = "contextCompactionThresholds";

/** 阈值的作用域：哪个渠道（provider）下的哪个模型。 */
export interface ContextCompactionThresholdModel {
  provider: string;
  id: string;
}

/**
 * 阈值条目的键：`provider:id`。
 * 渠道或模型缺失时返回 null —— 没有作用域的阈值不能写，否则会退化成全局设置。
 */
export function contextCompactionThresholdKey(
  model: ContextCompactionThresholdModel | null | undefined,
): string | null {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!provider || !id) return null;
  return `${provider}:${id}`;
}

/**
 * 归一化阈值：取整并 clamp 到 [10, 100]。
 * 非法值（缺失、非数字、NaN）一律退回默认值 100% —— 宁可不压，也不要在
 * 用户没配过的时候擅自压掉上下文。想提前压就把滑块往左拖。
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
 * 归一化「渠道 + 模型 → 阈值」映射：丢掉非法条目，其余 clamp 到允许区间。
 * 读到脏数据（手改 settings.json）时不至于让某个模型退回默认值。
 */
export function normalizeContextCompactionThresholdMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, percent] of Object.entries(value)) {
    const trimmed = key.trim();
    // 键是 `provider:id`：两段都必须非空。只判断 includes(":") 会放过
    // `:gpt-5` / `relay:` 这类脏键——它们永远匹配不到任何模型。
    // 模型 id 本身可以带冒号，所以只校验第一段和剩下的部分。
    const separator = trimmed.indexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    result[trimmed] = Math.round(
      Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, percent)),
    );
  }
  return result;
}

/**
 * 取某个模型的阈值：模型条目优先，其次旧版的全局值（升级兼容），最后默认值。
 * 同一渠道 + 同一模型在不同 Agent 下共用一条 —— 阈值是用户对这个模型的经验值。
 */
export function resolveContextCompactionThreshold(
  thresholds: Record<string, number> | null | undefined,
  model: ContextCompactionThresholdModel | null | undefined,
  legacyDefault?: unknown,
): number {
  const key = contextCompactionThresholdKey(model);
  const scoped = key ? thresholds?.[key] : undefined;
  if (typeof scoped === "number" && Number.isFinite(scoped)) {
    return normalizeContextCompactionThreshold(scoped);
  }
  if (legacyDefault !== undefined) return normalizeContextCompactionThreshold(legacyDefault);
  return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
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
