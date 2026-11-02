import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./agent-manager.ts", import.meta.url), "utf8");

describe("model catalog before the backend is ready", () => {
  it("serves the configured catalog while the session is still initializing", () => {
    // Pi / Claude / Codex 的 modelListMode 是 "configured"：目录来自 Hpp 自己的
    // models.json / settings.json，与 worker 启动无关。新会话在 worker 握手期间
    // 就应该能拿到目录，不必白等 ~1s 才显示模型名。
    expect(source).toContain("if (!agent || this.initializingSessionAgentTypes.has(sessionId))");
    expect(source).toContain("mergeModelsWithConfiguredAgentModels(agentType, [])");
    // init 进行中时问 backend 会挂到 4s 超时，所以必须走配置目录而不是 agent.getModels()
    expect(source).toContain("configured-only");
  });
});
