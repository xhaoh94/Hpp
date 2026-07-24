import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, type ChatMessage } from "./chat-store";
import { useProjectStore, type ProjectSession } from "./project-store";
import { useAgentCatalogStore } from "./agent-catalog-store";

const createSession = (id: string): ProjectSession => ({
  id,
  agentId: "codex",
  agentSessionId: id,
  title: id,
  createdAt: "2026-07-22T00:00:00.000Z",
  lastActiveAt: "2026-07-22T00:00:00.000Z",
});

describe("agent catalog plugin removal reconciliation", () => {
  const agentPluginRemove = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { electronAPI: { agentPluginRemove } });
    const initialized = createSession("initialized");
    const notInitialized = createSession("not-initialized");
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: initialized.createdAt,
        agents: ["codex"],
        sessions: [initialized, notInitialized],
      }],
      activeProjectId: "project",
      activeSessionId: initialized.id,
      agentStatuses: { [initialized.id]: "idle" },
      initializedSessionIds: new Set([initialized.id]),
    });
    const message = (id: string): ChatMessage => ({
      id: `message-${id}`,
      role: "user",
      content: id,
      timestamp: 1,
    });
    useChatStore.setState({
      messages: [message(initialized.id)],
      sessionMessages: {
        [initialized.id]: [message(initialized.id)],
        [notInitialized.id]: [message(notInitialized.id)],
      },
      activeSessionId: initialized.id,
      isStreaming: false,
      messageQueues: {},
    });
  });

  it("archives both detached and never-initialized open sessions after success", async () => {
    agentPluginRemove.mockResolvedValueOnce({
      success: true,
      agents: [],
      detachedSessionIds: ["initialized"],
    });

    const result = await useAgentCatalogStore.getState().removePlugin("codex");

    expect(result.detachedSessionIds).toEqual(["initialized", "not-initialized"]);
    expect(useProjectStore.getState().projects[0].sessions.every((session) => session.closed)).toBe(true);
    expect(useChatStore.getState().sessionMessages.initialized[0].content).toBe("initialized");
    expect(useChatStore.getState().sessionMessages["not-initialized"][0].content).toBe("not-initialized");
  });

  it("archives only unrecoverable detached sessions when removal fails", async () => {
    agentPluginRemove.mockResolvedValueOnce({
      success: false,
      error: "会话恢复失败",
      detachedSessionIds: ["initialized"],
    });

    const result = await useAgentCatalogStore.getState().removePlugin("codex");

    expect(result.detachedSessionIds).toEqual(["initialized"]);
    const sessions = useProjectStore.getState().projects[0].sessions;
    expect(sessions.find((session) => session.id === "initialized")?.closed).toBe(true);
    expect(sessions.find((session) => session.id === "not-initialized")?.closed).not.toBe(true);
  });
});
