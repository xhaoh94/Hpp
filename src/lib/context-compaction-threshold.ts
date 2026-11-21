import {
  CONTEXT_COMPACTION_THRESHOLDS_KEY,
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  contextCompactionThresholdKey,
  normalizeContextCompactionThreshold,
  normalizeContextCompactionThresholdMap,
  type ContextCompactionThresholdModel,
} from "@shared/context-compaction-threshold";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 旧版全局字段，只用于升级兼容读取；新写入一律落到按模型映射里。 */
const LEGACY_SETTINGS_KEY = "contextCompactionThreshold";
/** 更早的多档位字段，同样只用于兼容读取。 */
const LEGACY_TIERS_KEY = "contextCompactionTiers";

/**
 * 读某个模型的阈值。
 * 模型没有单独配置时退回旧版全局值，再退回默认值 —— 升级后行为保持连续，
 * 但任何一次拖动都只会写入当前模型这一条，不再影响其它模型。
 */
export async function loadContextCompactionThreshold(
  model?: ContextCompactionThresholdModel | null,
): Promise<number> {
  try {
    const data = await window.electronAPI.loadData("settings");
    const general = isRecord(data) ? data.general : undefined;
    if (!isRecord(general)) return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
    const thresholds = normalizeContextCompactionThresholdMap(general[CONTEXT_COMPACTION_THRESHOLDS_KEY]);
    const key = contextCompactionThresholdKey(model);
    if (key && thresholds[key] !== undefined) return thresholds[key];

    if (general[LEGACY_SETTINGS_KEY] !== undefined) {
      return normalizeContextCompactionThreshold(general[LEGACY_SETTINGS_KEY]);
    }
    const legacy = general[LEGACY_TIERS_KEY];
    if (Array.isArray(legacy) && legacy.length > 0) {
      return normalizeContextCompactionThreshold(legacy[0]);
    }
    return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
  } catch {
    return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
  }
}

/**
 * 写某个模型的阈值：交给主进程完成「读改写 + 落盘」。
 *
 * 渲染层原来自己 loadData → 改 → saveData，整份 settings 的读改写不在同一条
 * 队列里，和别的设置并发保存时会互相覆盖（拖阈值正好是高频写）。主进程写盘
 * 用的是与设置页共用的 `settings` 写队列，写完整条链路才返回。
 */
export async function saveContextCompactionThreshold(
  model: ContextCompactionThresholdModel | null | undefined,
  percent: number,
  options: { sessionId?: string | null } = {},
): Promise<void> {
  const normalized = normalizeContextCompactionThreshold(percent);
  const key = contextCompactionThresholdKey(model);
  try {
    await window.electronAPI.agentSetCompactionThreshold?.(normalized, {
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(key && model ? { model: { provider: model.provider, id: model.id } } : {}),
    });
  } catch {
    // 落盘失败由主进程记日志；界面已显示新值，下次拖动会再写一次。
  }
}
