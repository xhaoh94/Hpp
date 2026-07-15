import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { OpenCodeAgent } from "./backend";

interface OpenCodeInternals {
  sessionId: string | null;
  streamedContent: boolean;
  activeClientMessageId: string | null;
  handleSSEEvent: (eventType: string, data: unknown) => void;
  httpPost: (path: string, data: unknown) => Promise<unknown>;
}

describe("OpenCode interaction bridge", () => {
  it("preserves file paths from nested tool state inputs", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;

    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "tool_read_1",
          messageID: "message_1",
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "src/types/ipc.ts" },
            output: "file content",
          },
        },
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_start",
      toolKind: "read_file",
      filePath: "src/types/ipc.ts",
      files: [expect.objectContaining({
        file: "src/types/ipc.ts",
        action: "read",
      })],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_end",
      toolKind: "read_file",
      filePath: "src/types/ipc.ts",
    }));
  });

  it("keeps reasoning deltas separate from assistant text", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.activeClientMessageId = "client-message-1";

    internals.handleSSEEvent("message.updated", {
      properties: {
        info: { id: "msg_assistant_1", sessionID: "ses_source", role: "assistant" },
      },
    });
    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_reasoning_1",
          messageID: "msg_assistant_1",
          sessionID: "ses_source",
          type: "reasoning",
        },
      },
    });
    internals.handleSSEEvent("message.part.delta", {
      properties: {
        sessionID: "ses_source",
        messageID: "msg_assistant_1",
        partID: "part_reasoning_1",
        field: "text",
        delta: "working",
      },
    });
    internals.handleSSEEvent("message.part.updated", {
      properties: {
        part: {
          id: "part_text_1",
          messageID: "msg_assistant_1",
          sessionID: "ses_source",
          type: "text",
        },
        delta: "answer",
      },
    });
    await agent.dispose();

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_metadata",
      nativeTurnId: "msg_assistant_1",
      clientUserMessageId: "client-message-1",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "thinking_delta", delta: "working" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "stream_delta", delta: "answer" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "stream_delta", delta: "working" }));
  });

  it("does not add repeated OpenCode busy status entries", () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";

    internals.handleSSEEvent("session.status", {
      properties: { sessionID: "ses_source", status: { type: "busy" } },
    });
    internals.handleSSEEvent("session.status", {
      properties: { sessionID: "ses_source", status: { type: "busy" } },
    });

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "process_event",
      title: expect.stringContaining("OpenCode"),
    }));
  });

  it("forwards questions and questionnaire answers", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const httpPost = vi.fn(async () => true);
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.httpPost = httpPost;

    internals.handleSSEEvent("question.asked", {
      properties: {
        id: "que_1",
        sessionID: "ses_source",
        questions: [{
          header: "Approach",
          question: "Choose an approach",
          multiple: true,
          options: [{ label: "A" }, { label: "B" }],
        }],
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "process_event",
      entryType: "question",
      requestId: "que_1",
      method: "opencode.question",
    }));

    agent.sendUIResponse({
      id: "que_1",
      method: "opencode.question",
      answers: [{ selected: ["A", "B"] }],
    });

    await vi.waitFor(() => {
      expect(httpPost).toHaveBeenCalledWith("/question/que_1/reply", {
        answers: [["A", "B"]],
      });
    });
  });

  it("forwards permission decisions", async () => {
    const events: AgentEvent[] = [];
    const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
    const httpPost = vi.fn(async () => true);
    const internals = agent as unknown as OpenCodeInternals;
    internals.sessionId = "ses_source";
    internals.httpPost = httpPost;

    internals.handleSSEEvent("permission.v2.asked", {
      properties: {
        id: "per_1",
        sessionID: "ses_source",
        action: "edit",
        resources: ["src/app.ts"],
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "process_event",
      entryType: "question",
      requestId: "per_1",
      method: "opencode.permission",
    }));

    agent.sendUIResponse({
      id: "per_1",
      method: "opencode.permission",
      answers: [{ value: "always" }],
    });

    await vi.waitFor(() => {
      expect(httpPost).toHaveBeenCalledWith("/permission/per_1/reply", { reply: "always" });
    });
  });

  it("keeps the turn open while waiting for a UI response", async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const agent = new OpenCodeAgent("hpp-session", (event) => events.push(event));
      const httpPost = vi.fn(async () => true);
      const internals = agent as unknown as OpenCodeInternals;
      internals.sessionId = "ses_source";
      internals.streamedContent = true;
      internals.httpPost = httpPost;

      internals.handleSSEEvent("question.asked", {
        properties: {
          id: "que_waiting",
          sessionID: "ses_source",
          questions: [{ question: "Continue?" }],
        },
      });
      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(events).not.toContainEqual(expect.objectContaining({ type: "agent_end" }));

      agent.sendUIResponse({
        id: "que_waiting",
        method: "opencode.question",
        answers: [{ value: "yes" }],
      });
      await vi.waitFor(() => expect(httpPost).toHaveBeenCalled());

      internals.handleSSEEvent("session.idle", {
        properties: { sessionID: "ses_source" },
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
    } finally {
      vi.useRealTimers();
    }
  });
});
