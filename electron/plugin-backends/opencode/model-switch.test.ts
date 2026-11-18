import { describe, expect, it, vi } from "vitest";
import { OpenCodeAgent } from "./backend";
import { getOpenCodeProtocol } from "./protocol";

interface OpenCodeInternals {
  process: unknown;
  projectPath: string;
  protocol: ReturnType<typeof getOpenCodeProtocol>;
  currentModelId: string | null;
  currentProviderId: string | null;
  compactionConfig: { enabled: boolean; thinkingLevel: string };
  activeCompactionSignature: string;
  syncedModelKey: string | null;
  runtimeConfigPath: string | null;
  httpSend: (method: string, paths: string | string[], data?: unknown) => Promise<unknown>;
  init: (...args: unknown[]) => Promise<void>;
  getModels: () => Promise<unknown[]>;
}

function makeAgent(protocolId: "v1" | "v2") {
  const agent = new OpenCodeAgent();
  const internals = agent as unknown as OpenCodeInternals;
  // 有进程且 idle 才会进入「压缩配置需要跟随模型」的重载分支。
  internals.process = {};
  internals.projectPath = "C:/Project/Hpp";
  internals.protocol = getOpenCodeProtocol(protocolId);
  internals.currentProviderId = "old";
  internals.currentModelId = "old-model";
  internals.compactionConfig = { enabled: true, thinkingLevel: "low" };
  internals.activeCompactionSignature = "stale";
  internals.syncedModelKey = "old:old-model:";
  // 为 null 时 writeRuntimeConfig 直接返回，测试不碰磁盘。
  internals.runtimeConfigPath = null;
  internals.httpSend = vi.fn(async () => undefined);
  internals.init = vi.fn(async () => undefined);
  internals.getModels = vi.fn(async () => []);
  return { agent, internals };
}

describe("OpenCode model switch", () => {
  it("reloads V2 configuration in place instead of restarting the server", async () => {
    const { agent, internals } = makeAgent("v2");

    await agent.setModel("new", "new-model");

    expect(internals.httpSend).toHaveBeenCalledWith("POST", "/api/location/reload");
    expect(internals.init).not.toHaveBeenCalled();
    // reload 重建 location 后，会话级 model/agent/instructions 必须重新下发。
    expect(internals.syncedModelKey).toBeNull();
    // 签名要跟上新模型，否则下一次 init 还会误判成「配置变了」再次重启。
    expect(internals.activeCompactionSignature).toContain("new-model");
  });

  it("falls back to a runtime restart when the reload endpoint is unavailable", async () => {
    const { agent, internals } = makeAgent("v2");
    internals.httpSend = vi.fn(async () => {
      throw new Error("OpenCode POST /api/location/reload failed (404)");
    });

    await agent.setModel("new", "new-model");

    expect(internals.init).toHaveBeenCalledTimes(1);
    expect(internals.init).toHaveBeenCalledWith("C:/Project/Hpp", undefined, expect.objectContaining({
      compaction: { enabled: true, thinkingLevel: "low" },
    }));
  });

  it("reloads V2 configuration when the compaction thinking level changes", async () => {
    const { agent, internals } = makeAgent("v2");

    await agent.setCompactionConfig({ enabled: true, thinkingLevel: "high" });

    expect(internals.httpSend).toHaveBeenCalledWith("POST", "/api/location/reload");
    expect(internals.init).not.toHaveBeenCalled();
    expect(internals.activeCompactionSignature).toContain("\"thinkingLevel\":\"high\"");
  });

  it("keeps restarting for V1, which has no reload endpoint", async () => {
    const { agent, internals } = makeAgent("v1");

    await agent.setModel("new", "new-model");

    expect(internals.httpSend).not.toHaveBeenCalled();
    expect(internals.init).toHaveBeenCalledTimes(1);
  });
});
