import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useSessionModels.ts", import.meta.url), "utf8");

describe("useSessionModels thinking synchronization", () => {
  it("lets the ordered model-switch command reconcile thinking instead of racing it", () => {
    expect(source).toContain("SessionCommandCoordinator.setModel");
    expect(source).not.toContain("SessionCommandCoordinator.setThinking");
    expect(source).not.toContain("getSessionThinkingOrDefault");
  });

  it("clears the previous session catalog only when the Agent changes", () => {
    // 模型目录是 Agent 级的：同 Agent 内切会话保留（新建会话立即可见模型名），
    // 跨 Agent 同步清空。
    expect(source).toContain("previousAgentId !== activeSessionAgentId");
    expect(source).toContain("setAvailableModels([])");
    expect(source).toContain("useChatStore.setState({ currentModel: null })");
    expect(source).toContain("if (useChatStore.getState().availableModels.length === 0) clearModels();");
  });

  it("fetches the configured catalog in parallel with initialization", () => {
    // 模型目录不依赖 worker，初始化期间并行拉一次配置目录，请求到就渲染。
    expect(source).toContain("SessionCommandCoordinator.getConfiguredModels");
    expect(source).toContain("getConfiguredModels(activeSessionId, activeSessionAgentId)");
  });

  it("does not inherit a model across different Agents", () => {
    expect(source).toContain("currentSession?.agentId === session.agentId");
    expect(source).toContain("只在同一 Agent 内继承模型");
  });
});
