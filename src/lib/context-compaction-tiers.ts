import {
  DEFAULT_CONTEXT_COMPACTION_TIERS,
  normalizeContextCompactionTiers,
} from "@shared/context-compaction-tiers";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 从 settings.json 读智能压缩档位；没配过返回默认值。 */
export async function loadContextCompactionTiers(): Promise<number[]> {
  try {
    const data = await window.electronAPI.loadData("settings");
    const general = isRecord(data) ? data.general : undefined;
    const value = isRecord(general) ? general.contextCompactionTiers : undefined;
    const tiers = normalizeContextCompactionTiers(value);
    // 空数组是用户刻意关掉档位；只有字段缺失才回默认。
    return value === undefined ? [...DEFAULT_CONTEXT_COMPACTION_TIERS] : tiers;
  } catch {
    return [...DEFAULT_CONTEXT_COMPACTION_TIERS];
  }
}

/** 写智能压缩档位；读改写合并，保留 settings 和 general 的其它字段。 */
export async function saveContextCompactionTiers(tiers: number[]): Promise<void> {
  const normalized = normalizeContextCompactionTiers(tiers);
  const data = await window.electronAPI.loadData("settings");
  const settings = isRecord(data) ? data : {};
  const general = isRecord(settings.general) ? settings.general : {};
  await window.electronAPI.saveData("settings", {
    ...settings,
    general: { ...general, contextCompactionTiers: normalized },
  });
}
