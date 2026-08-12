import { describe, expect, it } from "vitest";
import type { ChatMessage, QueuedMessage } from "@/stores/chat-store";
import { createComposerDocument } from "@shared/composer-document";
import type { RemoteMessagePublish } from "./useRemoteBridge";
import { ASSISTANT_NARRATION_PROCESS_KIND } from "@shared/process-view";
import {
  buildRemoteInteractionSnapshot,
  canPublishMessageUpsert,
  coalescePendingMessageUpdate,
  flushPendingMessageUpdates,
  getRemoteInteractionUpdates,
  getRemoteSessionTitle,
  getRemoteStatusSettlementUpdates,
  relativeRemotePath,
  sanitizeRemoteAgent,
  sanitizeRemoteMessage,
  sanitizeRemoteMessages,
  sanitizeQueue,
  shouldPublishRemoteMessagesReplace,
  shouldFlushPendingMessageUpdate,
  toRemoteInteraction,
} from "./useRemoteBridge";

const message = (id: string, content = id): ChatMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: 1,
});

describe("remote renderer serialization", () => {
  it("never exposes absolute project paths in structured fields", () => {
    const sanitized = sanitizeRemoteMessage({
      ...message("assistant-1"),
      action: { kind: "skill", name: "review" },
      composerDraft: {
        text: "private draft",
        images: [],
        pendingFiles: [{ id: "private", fileName: "secret.ts", filePath: "C:\\work\\secret.ts", startLine: 1, endLine: 2 }],
        pendingPathAttachments: [],
        sessionReferences: [],
      },
      sessionReferences: [{ sourceSessionId: "session-2", sourceTitle: "Prior work" }],
      commentary: [{
        id: "commentary-1",
        content: "I am checking the release configuration.",
        timestamp: 2,
        isStreaming: true,
      }],
      diffs: [{ file: "C:\\work\\app\\src\\main.ts", patch: "@@", additions: 1, deletions: 0 }],
      process: {
        startedAt: 1,
        entries: [{
          id: "tool-1",
          type: "tool",
          title: "Read file",
          toolKind: "read_file",
          timestamp: 1,
          files: [{ file: "C:\\work\\app\\src\\main.ts" }],
        }],
      },
    }, "C:\\work\\app");

    expect(sanitized.diffs?.[0].file).toBe("src/main.ts");
    expect(sanitized.process?.entries[0].files?.[0].file).toBe("src/main.ts");
    expect(sanitized.process?.entries[0].toolKind).toBe("read_file");
    expect(sanitized.sessionReferences).toEqual([{ sourceSessionId: "session-2", sourceTitle: "Prior work" }]);
    expect(sanitized.commentary).toEqual([{
      id: "commentary-1",
      content: "I am checking the release configuration.",
      timestamp: 2,
      isStreaming: true,
    }]);
    expect(sanitized.action).toEqual({ kind: "skill", name: "review" });
    expect(sanitized).not.toHaveProperty("composerDraft");
    expect(JSON.stringify(sanitized)).not.toContain("C:\\\\work");
  });

  it("preserves subagent lifecycle details for remote timelines", () => {
    const sanitized = sanitizeRemoteMessage({
      ...message("assistant-subagents"),
      process: {
        startedAt: 1,
        entries: [{
          id: "subagent-1",
          type: "subagent",
          title: "已开始工作",
          timestamp: 2,
          state: "running",
          phase: "started",
          action: "spawnAgent",
          tool: "spawnAgent",
          startedAt: 2,
          subagents: [{
            id: "agent-1",
            label: "Frontend commentary",
            status: "running",
            model: "gpt-5",
            path: "/root/frontend",
            message: "Inspecting the renderer",
          }],
        }],
      },
    }, "C:\\work\\app");

    expect(sanitized.process?.entries[0]).toEqual({
      id: "subagent-1",
      type: "subagent",
      title: "已开始工作",
      toolKind: undefined,
      detail: undefined,
      command: undefined,
      exitCode: undefined,
      timestamp: 2,
      state: "running",
      phase: "started",
      action: "spawnAgent",
      tool: "spawnAgent",
      activityKind: undefined,
      startedAt: 2,
      completedAt: undefined,
      files: undefined,
      subagents: [{
        id: "agent-1",
        label: "Frontend commentary",
        status: "running",
        model: "gpt-5",
        path: "/root/frontend",
        message: "Inspecting the renderer",
      }],
    });
  });

  it("preserves structured guidance entries for mobile rendering", () => {
    const guidanceDocument = createComposerDocument([
      { id: "text", type: "text", text: "继续检查 " },
      { id: "file", type: "path", name: "README.md", path: "README.md", kind: "file" },
    ]);
    const sanitized = sanitizeRemoteMessage({
      ...message("assistant-guidance"),
      process: {
        startedAt: 1,
        entries: [{
          id: "guidance-1",
          type: "info",
          kind: "user_guidance",
          toolKind: "guidance_message",
          title: "引导",
          detail: "继续检查 [file: README.md]",
          timestamp: 2,
          state: "completed",
          guidanceDocument,
          guidanceImages: [{ id: "image-1", src: "data:image/png;base64,abc", name: "screen.png" }],
        }],
      },
    }, "C:\\work\\app");

    expect(sanitized.process?.entries[0]).toMatchObject({
      id: "guidance-1",
      kind: "user_guidance",
      toolKind: "guidance_message",
      guidanceDocument,
      guidanceImages: [{ id: "image-1", src: "data:image/png;base64,abc", name: "screen.png" }],
    });
  });

  it("settles orphaned remote process state when the session is no longer running", () => {
    const sanitized = sanitizeRemoteMessage({
      ...message("assistant-ended", "done"),
      isStreaming: true,
      commentary: [{ id: "commentary", content: "done", timestamp: 3_000, isStreaming: true }],
      process: {
        startedAt: 1_000,
        entries: [{
          id: "tool",
          type: "tool",
          title: "running",
          timestamp: 2_000,
          state: "running",
          subagents: [{ id: "subagent", label: "worker", status: "running" }],
        }],
        planSteps: [{ id: "step", title: "work", status: "running" }],
      },
    }, "C:\\work\\app", { turnRunning: false });

    expect(sanitized.isStreaming).toBe(false);
    expect(sanitized.commentary?.[0].isStreaming).toBe(false);
    expect(sanitized.process?.endedAt).toBe(3_000);
    expect(sanitized.process?.entries[0].state).toBe("completed");
    expect(sanitized.process?.entries[0].subagents?.[0].status).toBe("completed");
    expect(sanitized.process?.planSteps?.[0].status).toBe("completed");
  });

  it("keeps only the latest open assistant turn running in remote snapshots", () => {
    const old = {
      ...message("old"),
      process: { startedAt: 1_000, entries: [] },
    };
    const current = {
      ...message("current", ""),
      process: { startedAt: 2_000, entries: [] },
    };

    const sanitized = sanitizeRemoteMessages([old, current], "C:\\work\\app", "running");

    expect(sanitized[0].process?.endedAt).toBeDefined();
    expect(sanitized[1].process?.endedAt).toBeUndefined();
    expect(sanitizeRemoteMessages([old, current], "C:\\work\\app", "idle")
      .every((item) => item.process?.endedAt !== undefined)).toBe(true);
  });

  it("settles a final assistant body even while the catalog status is still running", () => {
    const [sanitized] = sanitizeRemoteMessages([{
      ...message("final-body", "最终正文"),
      isStreaming: false,
      commentary: [{ id: "stale-note", content: "中间说明", timestamp: 2_500, isStreaming: true }],
      process: {
        startedAt: 1_000,
        entries: [{
          id: "stale-tool",
          type: "tool",
          title: "正在读取",
          timestamp: 2_000,
          state: "running",
        }],
      },
    }], "C:\\work\\app", "running");

    expect(sanitized.isStreaming).toBe(false);
    expect(sanitized.commentary?.[0].isStreaming).toBe(false);
    expect(sanitized.process?.endedAt).toBeDefined();
    expect(sanitized.process?.entries[0].state).toBe("completed");
  });

  it("preserves the structured assistant narration kind for remote rendering", () => {
    const sanitized = sanitizeRemoteMessage({
      ...message("assistant-narration"),
      process: {
        startedAt: 1,
        entries: [{
          id: "narration-1",
          type: "info",
          kind: ASSISTANT_NARRATION_PROCESS_KIND,
          title: "任意标题",
          detail: "我先检查项目配置。",
          timestamp: 2,
        }],
      },
    }, "C:\\work\\app");

    expect(sanitized.process?.entries[0].kind).toBe(ASSISTANT_NARRATION_PROCESS_KIND);
  });

  it("preserves command warning details for remote rendering", () => {
    const sanitized = sanitizeRemoteMessage({
      ...message("assistant-command-warning"),
      process: {
        startedAt: 1,
        entries: [{
          id: "command-1",
          type: "tool",
          title: "命令返回非零退出码 1",
          toolKind: "run_command",
          command: "rg missing",
          exitCode: 1,
          timestamp: 2,
          state: "warning",
        }],
      },
    }, "C:\\work\\app");

    expect(sanitized.process?.entries[0]).toMatchObject({
      toolKind: "run_command",
      command: "rg missing",
      exitCode: 1,
      state: "warning",
    });
  });

  it("reduces unrelated absolute paths to their basename", () => {
    expect(relativeRemotePath("D:\\secret\\outside.txt", "C:\\work\\app")).toBe("outside.txt");
  });

  it("exposes editable queue attachment names without desktop paths", () => {
    const queue: QueuedMessage[] = [{
      id: "queued-1",
      sessionId: "session-1",
      editableContent: "review",
      displayContent: "review",
      sendContent: "private payload",
      createdAt: 1,
      status: "queued",
      editableDraft: {
        text: "review",
        images: [],
        pendingFiles: [{ id: "snippet-1", fileName: "secret.ts", filePath: "C:\\work\\private\\secret.ts", startLine: 2, endLine: 4 }],
        pendingPathAttachments: [{ id: "file-1", name: "notes.txt", path: "D:\\private\\notes.txt", kind: "file" }],
        sessionReferences: [],
      },
    }];

    const sanitized = sanitizeQueue(queue);
    expect(sanitized[0].attachments).toEqual([
      { id: "snippet-1", name: "secret.ts:2-4", kind: "snippet" },
      { id: "file-1", name: "notes.txt", kind: "file" },
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("C:\\\\work");
    expect(JSON.stringify(sanitized)).not.toContain("D:\\\\private");
    expect(JSON.stringify(sanitized)).not.toContain("private payload");
  });

  it("only publishes non-sensitive agent metadata", () => {
    const agent = {
      id: "codex",
      name: "Codex",
      description: "Coding agent",
      runtime: "cli" as const,
      capabilities: { providerActivation: "single-active", guidance: true, actions: true },
      command: "secret-command",
      installedPath: "C:\\private\\plugins\\codex",
    };
    const sanitized = sanitizeRemoteAgent(agent);

    expect(sanitized).toEqual({
      id: "codex",
      name: "Codex",
      description: "Coding agent",
      runtime: "cli",
      requiresProviderActivation: true,
      supportsGuidance: true,
      supportsActions: true,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-command");
    expect(JSON.stringify(sanitized)).not.toContain("private");
  });

  it("uses upserts only for append or last-message updates", () => {
    const first = message("1");
    const second = message("2");
    expect(canPublishMessageUpsert([first], [first, second])).toBe(true);
    expect(canPublishMessageUpsert([first, second], [first, { ...second, content: "stream" }])).toBe(true);
    expect(canPublishMessageUpsert([first, second], [{ ...first, content: "completed process" }, second])).toBe(false);
    expect(canPublishMessageUpsert([first, second], [second])).toBe(false);
  });

  it("uses a full replacement when the active assistant turn changes", () => {
    const user = { ...message("user", "go"), role: "user" as const };
    const runningAssistant: ChatMessage = {
      ...message("assistant-running", ""),
      isStreaming: true,
      process: { startedAt: 2, entries: [] },
    };
    const nextUser = { ...message("next-user", "continue"), role: "user" as const };

    expect(shouldPublishRemoteMessagesReplace(
      [user],
      [user, runningAssistant],
      "running",
    )).toBe(false);
    expect(shouldPublishRemoteMessagesReplace(
      [user, runningAssistant],
      [user, runningAssistant, nextUser],
      "running",
    )).toBe(true);
    expect(shouldPublishRemoteMessagesReplace(
      [user, runningAssistant],
      [user, { ...runningAssistant, content: "stream chunk" }],
      "running",
    )).toBe(false);
  });

  it("repairs remote message caches when a running session becomes terminal", () => {
    const runningAssistant: ChatMessage = {
      ...message("assistant-running", ""),
      isStreaming: true,
      commentary: [{ id: "note", content: "working", timestamp: 3, isStreaming: true }],
      process: {
        startedAt: 1,
        entries: [{
          id: "tool",
          type: "tool",
          title: "running",
          timestamp: 2,
          state: "running",
        }],
      },
    };
    const projects = [{
      id: "project-1",
      name: "Project",
      path: "C:\\work\\app",
      createdAt: "2026-01-01T00:00:00.000Z",
      agents: ["codex"],
      sessions: [{
        id: "session-1",
        agentId: "codex",
        agentSessionId: "native-1",
        title: "Session",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      }],
    }];

    const [update] = getRemoteStatusSettlementUpdates(
      { "session-1": "running" },
      { "session-1": "idle" },
      projects,
      { "session-1": [runningAssistant] },
    );

    expect(update.type).toBe("session.messages.replace");
    if (update.type !== "session.messages.replace") throw new Error("expected replacement");
    expect(update.messages[0]).toMatchObject({
      isStreaming: false,
      commentary: [{ isStreaming: false }],
      process: {
        endedAt: 3,
        entries: [{ state: "completed" }],
      },
    });
    expect(getRemoteStatusSettlementUpdates(
      { "session-1": "idle" },
      { "session-1": "completed" },
      projects,
      { "session-1": [runningAssistant] },
    )).toEqual([]);
    expect(getRemoteStatusSettlementUpdates(
      { "session-1": "running" },
      {},
      projects,
      { "session-1": [runningAssistant] },
    )[0]).toMatchObject({
      type: "session.messages.replace",
      messages: [{ isStreaming: false, process: { entries: [{ state: "completed" }] } }],
    });
  });

  it("flushes a pending user upsert before publishing a different assistant message", () => {
    const userUpdate = {
      type: "session.message.upsert" as const,
      sessionId: "session-1",
      message: { id: "user-1", role: "user" as const, content: "hello", timestamp: 1 },
    };
    const assistantUpdate = {
      type: "session.message.upsert" as const,
      sessionId: "session-1",
      message: { id: "assistant-1", role: "assistant" as const, content: "", timestamp: 2 },
    };
    const streamedAssistantUpdate = {
      ...assistantUpdate,
      message: { ...assistantUpdate.message, content: "working" },
    };

    expect(shouldFlushPendingMessageUpdate(userUpdate, assistantUpdate)).toBe(true);
    expect(shouldFlushPendingMessageUpdate(assistantUpdate, streamedAssistantUpdate)).toBe(false);
  });

  it("keeps a pending full replacement when a later upsert updates its newest message", () => {
    const repairedOldMessage = {
      id: "assistant-old",
      role: "assistant" as const,
      content: "done",
      timestamp: 1,
      process: { startedAt: 1, endedAt: 2, entries: [] },
    };
    const newMessage = {
      id: "assistant-new",
      role: "assistant" as const,
      content: "",
      timestamp: 3,
      process: { startedAt: 3, entries: [] },
    };
    const replacement = {
      type: "session.messages.replace" as const,
      sessionId: "session-1",
      messages: [repairedOldMessage, newMessage],
    };
    const streamedUpsert = {
      type: "session.message.upsert" as const,
      sessionId: "session-1",
      message: { ...newMessage, content: "working" },
    };

    const result = coalescePendingMessageUpdate(replacement, streamedUpsert);

    expect(result.flush).toBeUndefined();
    expect(result.pending).toEqual({
      ...replacement,
      messages: [repairedOldMessage, streamedUpsert.message],
    });
  });

  it("lets a newer full replacement supersede any pending message update", () => {
    const pendingUpsert = {
      type: "session.message.upsert" as const,
      sessionId: "session-1",
      message: { id: "assistant-1", role: "assistant" as const, content: "working", timestamp: 1 },
    };
    const replacement = {
      type: "session.messages.replace" as const,
      sessionId: "session-1",
      messages: [
        { id: "assistant-1", role: "assistant" as const, content: "done", timestamp: 1 },
        { id: "assistant-2", role: "assistant" as const, content: "", timestamp: 2 },
      ],
    };

    const olderReplacement = {
      ...replacement,
      messages: [pendingUpsert.message],
    };

    expect(coalescePendingMessageUpdate(pendingUpsert, replacement)).toEqual({ pending: replacement });
    expect(coalescePendingMessageUpdate(olderReplacement, replacement)).toEqual({ pending: replacement });
  });

  it("flushes every coalesced message update during bridge cleanup", () => {
    const first = {
      type: "session.message.upsert" as const,
      sessionId: "session-1",
      message: { id: "assistant-1", role: "assistant" as const, content: "done", timestamp: 1 },
    };
    const second = {
      type: "session.messages.replace" as const,
      sessionId: "session-2",
      messages: [{ id: "assistant-2", role: "assistant" as const, content: "done", timestamp: 2 }],
    };
    const pending = new Map<string, RemoteMessagePublish>([
      [first.sessionId, first],
      [second.sessionId, second],
    ]);
    const published: RemoteMessagePublish[] = [];

    flushPendingMessageUpdates(pending, (update) => published.push(update));

    expect(published).toEqual([first, second]);
    expect(pending.size).toBe(0);
  });

  it("forwards pending questionnaire fields to remote clients", () => {
    expect(toRemoteInteraction({
      sessionId: "session-1",
      requestId: "question-1",
      method: "opencode.question",
      questions: [{
        id: "approach",
        header: "Approach",
        question: "Choose one",
        multiSelect: true,
        options: [{ label: "A", value: "a", description: "Option A" }],
      }],
    })).toEqual({
      sessionId: "session-1",
      requestId: "question-1",
      method: "opencode.question",
      questions: [{
        id: "approach",
        header: "Approach",
        question: "Choose one",
        multiSelect: true,
        options: [{ label: "A", value: "a", description: "Option A" }],
      }],
    });
  });

  it("includes concurrent interactions for every open session in a snapshot", () => {
    const interactionA = {
      sessionId: "A",
      requestId: "request-A",
      method: "question",
      questions: [],
    };
    const interactionB = {
      sessionId: "B",
      requestId: "request-B",
      method: "confirm",
      questions: [],
    };
    const interactions = { A: interactionA, B: interactionB };

    expect(buildRemoteInteractionSnapshot(
      [{ id: "A" }, { id: "B" }, { id: "closed", closed: true }],
      (sessionId) => interactions[sessionId as keyof typeof interactions] || null,
    )).toEqual({
      A: toRemoteInteraction(interactionA),
      B: toRemoteInteraction(interactionB),
      closed: null,
    });
  });

  it("publishes per-session interaction additions and removals without clearing siblings", () => {
    const interactionA = {
      sessionId: "A",
      requestId: "request-A",
      method: "question",
      questions: [],
    };
    const interactionB = {
      sessionId: "B",
      requestId: "request-B",
      method: "question",
      questions: [],
    };

    expect(getRemoteInteractionUpdates({}, { A: interactionA, B: interactionB })).toEqual([
      { type: "session.interaction", sessionId: "A", interaction: toRemoteInteraction(interactionA) },
      { type: "session.interaction", sessionId: "B", interaction: toRemoteInteraction(interactionB) },
    ]);
    expect(getRemoteInteractionUpdates(
      { A: interactionA, B: interactionB },
      { A: interactionA },
    )).toEqual([
      { type: "session.interaction", sessionId: "B", interaction: null },
    ]);
  });

  it("uses the complete first-user-message title for responsive web truncation", () => {
    expect(getRemoteSessionTitle("新会话", [message("assistant")])).toBe("新会话");
    expect(getRemoteSessionTitle("新会话", [{ ...message("reference-only", ""), role: "user" }])).toBe("新会话");
    expect(getRemoteSessionTitle("新会话", [{ ...message("user", "同步后的会话标题"), role: "user" }])).toBe("同步后的会话标题");
    const longTitle = "a".repeat(120);
    expect(getRemoteSessionTitle("新会话", [{ ...message("user", longTitle), role: "user" }])).toBe(longTitle);
  });
});
