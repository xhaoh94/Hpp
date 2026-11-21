import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const managerSource = readFileSync(resolve(process.cwd(), "electron/agents/agent-manager.ts"), "utf8");
const controllerSource = readFileSync(
  resolve(process.cwd(), "electron/agents/context-compaction-controller.ts"),
  "utf8",
);
const rendererStore = readFileSync(
  resolve(process.cwd(), "src/lib/context-compaction-threshold.ts"),
  "utf8",
);

describe("compaction threshold is scoped by channel and model", () => {
  it("reads and writes the per-model map instead of one global percentage", () => {
    // 渲染层只负责读映射 + 发命令：写盘搬到了主进程，避免整份 settings 的
    // 读改写和别的设置并发保存时互相覆盖。
    expect(rendererStore).toContain("CONTEXT_COMPACTION_THRESHOLDS_KEY");
    expect(rendererStore).toContain("contextCompactionThresholdKey(model)");
    expect(rendererStore).toContain("agentSetCompactionThreshold?.(normalized");

    // 主进程从 settings 读映射 + 旧全局兜底，而不是只读一个数。
    expect(managerSource).toContain("contextCompactionThresholds?: unknown");
    expect(managerSource).toContain("normalizeContextCompactionThresholdMap");
    expect(managerSource).toContain("resolveContextCompactionThreshold");
    // 读改写落在与其它设置共用的 settings 写队列里。
    expect(managerSource).toContain('queueNamedWrite("settings"');
    expect(managerSource).toContain("thresholds[key] = percent");
  });

  it("switches to the new model's threshold after a model change", () => {
    expect(managerSource).toContain('event.type === "model_changed"');
    expect(managerSource).toContain("readContextCompactionModel(event.model)");
    expect(managerSource).toContain("applySessionModel(sessionId, model)");
    expect(managerSource).toContain("rememberSessionModel(");
  });

  it("keeps the per-session threshold in the controller, not a single field", () => {
    expect(controllerSource).toContain("sessionThresholds");
    expect(controllerSource).toContain("setSessionThreshold(sessionId: string, value: unknown)");
    expect(controllerSource).toContain("getThreshold(sessionId?: string)");
    // 缺省阈值只给没有模型信息的会话兜底；不能反过来覆盖会话级配置。
    expect(controllerSource).toContain("if (this.sessionThresholds.has(sessionId)) continue;");
  });

  it("no longer exposes a single global setter on the renderer side", () => {
    // 反向断言：旧的无参数调用会把阈值写成全局值。
    expect(rendererStore).not.toContain("saveContextCompactionThreshold(percent)");
    expect(managerSource).not.toContain("agentManager.setCompactionThreshold(percent);");
  });
});
