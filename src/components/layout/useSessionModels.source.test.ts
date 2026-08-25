import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./useSessionModels.ts", import.meta.url), "utf8");

describe("useSessionModels thinking synchronization", () => {
  it("lets the ordered model-switch command reconcile thinking instead of racing it", () => {
    expect(source).toContain("SessionCommandCoordinator.setModel");
    expect(source).not.toContain("SessionCommandCoordinator.setThinking");
    expect(source).not.toContain("getSessionThinkingOrDefault");
  });

  it("clears the previous session catalog before asynchronous discovery", () => {
    expect(source).toContain("useEffect(() => {\n    clearModels();\n  }, [activeSessionId, activeSessionAgentId, clearModels]);");
    expect(source).toContain("setAvailableModels([])");
    expect(source).toContain("useChatStore.setState({ currentModel: null })");
    expect(source).toContain("if (useChatStore.getState().availableModels.length === 0) clearModels();");
  });

  it("does not inherit a model across different Agents", () => {
    expect(source).toContain("currentSession?.agentId === session.agentId");
    expect(source).toContain("只在同一 Agent 内继承模型");
  });
});
