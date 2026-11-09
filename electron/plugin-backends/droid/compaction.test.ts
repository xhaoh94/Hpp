import { describe, expect, it } from "vitest";
import { buildDroidRuntimeSettings } from "./backend";

describe("Droid context compaction config", () => {
  // Hpp 已移除独立压缩渠道：Droid 永远跟随当前会话模型，且升级后要清掉
  // 旧版本注入的 custom:hpp:compaction 条目。
  it("always compacts with the session model and drops the legacy Hpp model", () => {
    const settings = buildDroidRuntimeSettings({
      keepMe: true,
      customModels: [{
        id: "custom:user:model",
        model: "user-model",
        displayName: "User model",
      }, {
        id: "custom:hpp:compaction",
        hppCompactionManaged: true,
        model: "old-model",
      }],
      compactionModel: "custom:hpp:compaction",
    }, {
      thinkingLevel: "low",
      modelMode: "custom",
      model: "tanwan/summary",
    });

    expect(settings.keepMe).toBe(true);
    expect(settings.compactionModel).toBe("same");
    expect(settings.customModels).toEqual([
      expect.objectContaining({ id: "custom:user:model", model: "user-model" }),
    ]);
  });

  it("keeps unrelated custom models untouched when no Hpp entry exists", () => {
    const settings = buildDroidRuntimeSettings({
      customModels: [{ id: "custom:user:model", model: "keep" }],
    }, { thinkingLevel: "inherit", modelMode: "current" });

    expect(settings.compactionModel).toBe("same");
    expect(settings.customModels).toEqual([expect.objectContaining({ id: "custom:user:model" })]);
  });

  it("treats a non-array customModels value as empty", () => {
    const settings = buildDroidRuntimeSettings({ customModels: "broken" }, undefined);

    expect(settings.customModels).toEqual([]);
    expect(settings.compactionModel).toBe("same");
  });
});
