import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../src/types/ipc";
import { DroidAgent } from "./backend";

interface DroidInternals {
  process: unknown;
  isReady: boolean;
  sessionId: string | null;
  turnActive: boolean;
  clientMessageIdsByRequestId: Map<string, string>;
  sendRpcAsync: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  handleNotification: (method: string, params: unknown) => void;
}

describe("Droid native fork", () => {
  it("forks at a native message without changing workspace files", async () => {
    const agent = new DroidAgent();
    const sendRpcAsync = vi.fn(async () => ({ result: { newSessionId: "droid-forked" } }));
    const internals = agent as unknown as DroidInternals;
    internals.process = {};
    internals.isReady = true;
    internals.sessionId = "droid-source";
    internals.sendRpcAsync = sendRpcAsync;

    const result = await agent.forkSession({
      newSessionId: "hpp-fork",
      sourceSessionFilePath: "droid-source",
      sourceUserMessageIndex: 1,
      rollbackUserMessageCount: 2,
      targetTurnId: "droid-message-2",
      sourceMessageContent: "Take another approach",
    });

    expect(sendRpcAsync).toHaveBeenCalledWith("droid.execute_rewind", {
      sessionId: "droid-source",
      messageId: "droid-message-2",
      filesToRestore: [],
      filesToDelete: [],
      forkTitle: "Take another approach",
    }, 60000);
    expect(result).toEqual({
      supported: true,
      success: true,
      sessionFilePath: "droid-forked",
      nativeEntryId: "droid-message-2",
    });
  });

  it("uses protocol fields and associates the assistant reply with the Hpp turn", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;
    internals.clientMessageIdsByRequestId.set("rpc-2", "hpp-message-2");

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        requestId: "rpc-2",
        message: { id: "droid-message-2", role: "user" },
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_metadata",
      nativeTurnId: "droid-message-2",
      clientUserMessageId: "hpp-message-2",
    }));

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "assistant_text_delta",
        messageId: "droid-assistant-2",
        blockIndex: 0,
        textDelta: "answer",
      },
    });
    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "assistant_text_complete",
        messageId: "droid-assistant-2",
        blockIndex: 0,
      },
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "stream_delta", delta: "answer" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn_metadata",
      nativeTurnId: "droid-assistant-2",
      clientUserMessageId: "hpp-message-2",
    }));
    expect(events.some((event) => event.type === "agent_end")).toBe(false);

    internals.handleNotification("droid.session_notification", {
      notification: { type: "droid_working_state_changed", newState: "idle" },
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "stream_end" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));

    internals.turnActive = true;
    internals.handleNotification("droid.session_notification", {
      notification: { type: "droid_working_state_changed", working: false },
    });
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(2);
  });

  it("normalizes Droid tool progress payloads", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "tool_progress_update",
        toolUseId: "tool-1",
        toolName: "execute-cli",
        update: {
          type: "tool_result",
          parameters: { command: "npm test" },
          fullOutput: "passed",
        },
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_end",
      toolCallId: "tool-1",
      toolName: "execute-cli",
      result: "passed",
    }));
  });

  it("emits file tools from Droid create_message content blocks", () => {
    const events: AgentEvent[] = [];
    const agent = new DroidAgent("hpp-session", (event) => events.push(event));
    const internals = agent as unknown as DroidInternals;
    internals.turnActive = true;

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "create_message",
        message: {
          id: "assistant-tools-1",
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "C:\\Project\\Hpp\\README.md" },
          }, {
            type: "tool_use",
            id: "list-1",
            name: "LS",
            input: { directory_path: "C:\\Project\\Hpp" },
          }],
        },
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_start",
      toolCallId: "read-1",
      toolKind: "read_file",
      filePath: "C:\\Project\\Hpp\\README.md",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_start",
      toolCallId: "list-1",
      toolKind: "list_dir",
      filePath: "C:\\Project\\Hpp",
    }));

    internals.handleNotification("droid.session_notification", {
      notification: {
        type: "droid_working_state_changed",
        newState: "streaming_assistant_message",
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_end",
      toolCallId: "read-1",
      files: [expect.objectContaining({ file: "C:\\Project\\Hpp\\README.md", action: "read" })],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_end",
      toolCallId: "list-1",
      files: [expect.objectContaining({ file: "C:\\Project\\Hpp", action: "listed" })],
    }));
  });
});
