import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import {
  canPublishMessageUpsert,
  getRemoteSessionTitle,
  relativeRemotePath,
  sanitizeRemoteAgent,
  sanitizeRemoteMessage,
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
      sessionReferences: [{ sourceSessionId: "session-2", sourceTitle: "Prior work" }],
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
    expect(JSON.stringify(sanitized)).not.toContain("C:\\\\work");
  });

  it("reduces unrelated absolute paths to their basename", () => {
    expect(relativeRemotePath("D:\\secret\\outside.txt", "C:\\work\\app")).toBe("outside.txt");
  });

  it("only publishes non-sensitive agent metadata", () => {
    const agent = {
      id: "codex",
      name: "Codex",
      description: "Coding agent",
      runtime: "cli" as const,
      capabilities: { providerActivation: "single-active", guidance: true },
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

  it("uses the same first-user-message title shown by the desktop", () => {
    expect(getRemoteSessionTitle("新会话", [message("assistant")])).toBe("新会话");
    expect(getRemoteSessionTitle("新会话", [{ ...message("reference-only", ""), role: "user" }])).toBe("新会话");
    expect(getRemoteSessionTitle("新会话", [{ ...message("user", "同步后的会话标题"), role: "user" }])).toBe("同步后的会话标题");
    const longTitle = "a".repeat(35);
    expect(getRemoteSessionTitle("新会话", [{ ...message("user", longTitle), role: "user" }])).toBe(`${"a".repeat(30)}...`);
  });
});
