import {
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  normalizeContextCompactionThreshold,
} from "@shared/context-compaction-threshold";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** settings.general 里的字段名（单阈值）。 */
const SETTINGS_KEY = "contextCompactionThreshold";
/** 旧版多档位字段，仅用于迁移读取。 */
const LEGACY_TIERS_KEY = "contextCompactionTiers";

/** 从 settings.json 读智能压缩阈值；没配过返回默认值。 */
export async function loadContextCompactionThreshold(): Promise<number> {
  try {
    const data = await window.electronAPI.loadData("settings");
    const general = isRecord(data) ? data.general : undefined;
    if (!isRecord(general)) return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
    if (general[SETTINGS_KEY] !== undefined) {
      return normalizeContextCompactionThreshold(general[SETTINGS_KEY]);
    }
    // 兼容上一版的多档位配置：取最低档当阈值，避免用户已经调过的值被丢掉。
    const legacy = general[LEGACY_TIERS_KEY];
    if (Array.isArray(legacy) && legacy.length > 0) {
      return normalizeContextCompactionThreshold(legacy[0]);
    }
    return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
  } catch {
    return DEFAULT_CONTEXT_COMPACTION_THRESHOLD;
  }
}

/** 写智能压缩阈值；读改写合并，保留 settings 和 general 的其它字段。 */
export async function saveContextCompactionThreshold(percent: number): Promise<void> {
  const normalized = normalizeContextCompactionThreshold(percent);
  const data = await window.electronAPI.loadData("settings");
  const settings = isRecord(data) ? data : {};
  const general = isRecord(settings.general) ? settings.general : {};
  const { [LEGACY_TIERS_KEY]: _legacyTiers, ...restGeneral } = general;
  await window.electronAPI.saveData("settings", {
    ...settings,
    general: { ...restGeneral, [SETTINGS_KEY]: normalized },
  });
}
