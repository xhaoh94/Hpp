import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore, type ChatMessage } from "@/stores/chat-store";
import { useProjectStore, type ProjectSession } from "@/stores/project-store";
import { archiveSessionsAfterBackendRemoval } from "./session-lifecycle";

const session: ProjectSession = {
  id: "session-one",
  agentId: "codex",
  agentSessionId: "session-one",
  title: "Conversation",
  createdAt: "2026-07-22T00:00:00.000Z",
  lastActiveAt: "2026-07-22T00:00:00.000Z",
  sessionFilePath: "native-session",
  references: [{ sourceSessionId: "source", sourceTitle: "Source" }],
};

const messages: ChatMessage[] = [
  { id: "user", role: "user", content: "hello", timestamp: 1 },
  { id: "assistant", role: "assistant", content: "world", timestamp: 2 },
];

describe("archiveSessionsAfterBackendRemoval", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{
        id: "project",
        name: "Project",
        path: "C:\\project",
        createdAt: session.createdAt,
        agents: ["codex"],
        sessions: [{ ...session }],
      }],
      activeProjectId: "project",
      activeSessionId: session.id,
      agentStatuses: { [session.id]: "idle" },
      initializedSessionIds: new Set([session.id]),
    });
    useChatStore.setState({
      messages: [...messages],
      sessionMessages: { [session.id]: [...messages] },
      activeSessionId: session.id,
      isStreaming: true,
      sessionDrafts: {
        [session.id]: {
          text: "keep this draft",
          pendingImages: [],
          pendingFiles: [],
          pendingPathAttachments: [],
          sessionReferences: [],
        },
      },
      messageQueues: {
        [session.id]: [{
          id: "queued",
          sessionId: session.id,
          displayContent: "later",
          sendContent: "later",
          createdAt: 3,
          status: "queued",
        }],
      },
    });
  });

  it("archives runtime state while preserving messages, draft, native path, and references", () => {
    expect(archiveSessionsAfterBackendRemoval([session.id])).toEqual([session.id]);

    const projectSession = useProjectStore.getState().projects[0].sessions[0];
    expect(projectSession).toMatchObject({
      closed: true,
      sessionFilePath: "native-session",
      references: session.references,
    });
    expect(useProjectStore.getState().activeSessionId).toBeNull();
    expect(useProjectStore.getState().initializedSessionIds.has(session.id)).toBe(false);
    expect(useProjectStore.getState().agentStatuses[session.id]).toBeUndefined();

    const chat = useChatStore.getState();
    expect(chat.activeSessionId).toBeNull();
    expect(chat.isStreaming).toBe(false);
    expect(chat.sessionMessages[session.id]).toEqual(messages);
    expect(chat.sessionDrafts[session.id]).toMatchObject({ text: "keep this draft" });
    expect(chat.messageQueues[session.id]).toBeUndefined();
  });

  it("interrupts every open process and compaction before archiving the session", () => {
    const runningMessages: ChatMessage[] = [
      messages[0],
      {
        id: "assistant-running",
        role: "assistant",
        content: "partial",
        timestamp: 2,
        isStreaming: true,
        commentary: [{ id: "commentary", content: "working", timestamp: 3, isStreaming: true }],
        process: {
          startedAt: 2,
          entries: [{
            id: "tool",
            type: "tool",
            title: "running",
            timestamp: 3,
            state: "running",
            subagents: [{ id: "child", label: "child", status: "running" }],
          }],
          planSteps: [{ id: "step", title: "step", status: "running" }],
        },
      },
      {
        id: "compaction",
        role: "system",
        content: "compacting",
        timestamp: 4,
        systemType: "context_compaction",
        compactionState: "running",
      },
    ];
    useChatStore.setState({
      messages: runningMessages,
      sessionMessages: { [session.id]: runningMessages },
      compactingSessions: { [session.id]: true },
    });

    archiveSessionsAfterBackendRemoval([session.id]);

    const archivedMessages = useChatStore.getState().sessionMessages[session.id];
    const assistant = archivedMessages.find((message) => message.id === "assistant-running");
    expect(assistant).toMatchObject({
      isStreaming: false,
      commentary: [{ isStreaming: false }],
      process: {
        entries: [{ state: "interrupted", subagents: [{ status: "interrupted" }] }],
        planSteps: [{ status: "cancelled" }],
      },
    });
    expect(assistant?.process?.endedAt).toBe(3);
    expect(archivedMessages.find((message) => message.id === "compaction"))
      .toMatchObject({ compactionState: "interrupted" });
    expect(useChatStore.getState().compactingSessions[session.id]).toBeUndefined();
  });
});
