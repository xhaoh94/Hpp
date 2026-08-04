import { describe, expect, it } from "vitest";
import {
  ASSISTANT_NARRATION_PROCESS_KIND,
  formatProcessDuration,
  getUserGuidanceText,
  getActiveAssistantTurnId,
  getProcessGroupState,
  getVisibleProcessEntries,
  groupProcessEntries,
  isCommandProcessEntry,
  isProcessInterrupted,
  isProcessViewRunning,
  isUserGuidanceProcessEntry,
  normalizeProcessForView,
  splitCommandDetail,
  type ProcessEntryView,
} from "./process-view";

const entry = (patch: Partial<ProcessEntryView> & Pick<ProcessEntryView, "id" | "type" | "title">): ProcessEntryView => patch;

describe("shared process view model", () => {
  it("formats process duration consistently across desktop and mobile", () => {
    expect(formatProcessDuration(-1)).toBe("0s");
    expect(formatProcessDuration(59_999)).toBe("59s");
    expect(formatProcessDuration(61_000)).toBe("1m 1s");
    expect(formatProcessDuration(Number.NaN)).toBe("0s");
  });

  it("settles stale running fields when the owning turn is no longer running", () => {
    const process = {
      startedAt: 1_000,
      endedAt: undefined as number | undefined,
      entries: [{
        id: "tool",
        type: "tool" as const,
        title: "running",
        state: "running" as const,
        phase: "started" as const,
        timestamp: 2_000,
        subagents: [{ id: "subagent", status: "running" as const }],
      }],
      planSteps: [{ id: "step", status: "running" }],
    };

    const settled = normalizeProcessForView(process, { running: false, fallbackEndedAt: 1_500 });

    expect(settled.endedAt).toBe(2_000);
    expect(settled.entries[0]).toMatchObject({
      state: "completed",
      phase: "completed",
      completedAt: 2_000,
      subagents: [{ id: "subagent", status: "completed" }],
    });
    expect(settled.planSteps?.[0].status).toBe("completed");
    expect(isProcessViewRunning(settled, true)).toBe(false);
  });

  it("uses error terminal states and never revives a process that already ended", () => {
    const process = {
      startedAt: 1_000,
      endedAt: 2_000,
      entries: [entry({ id: "tool", type: "tool", title: "running", state: "running" })],
      planSteps: [{ id: "step", status: "pending" }],
    };

    const settled = normalizeProcessForView(process, { running: true, terminalState: "error" });

    expect(settled.entries[0].state).toBe("error");
    expect(settled.planSteps?.[0].status).toBe("failed");
    expect(settled.endedAt).toBe(2_000);
  });

  it("selects only the latest open assistant turn after the last user message", () => {
    const messages = [
      { id: "old", role: "assistant", process: { endedAt: undefined } },
      { id: "user", role: "user" },
      { id: "current", role: "assistant", process: { endedAt: undefined } },
    ];

    expect(getActiveAssistantTurnId(messages, true)).toBe("current");
    expect(getActiveAssistantTurnId(messages, false)).toBeNull();
    expect(getActiveAssistantTurnId([
      ...messages,
      { id: "next-user", role: "user" },
    ], true)).toBeNull();
  });

  it("treats a non-streaming final body as settled despite stale process markers", () => {
    expect(getActiveAssistantTurnId([
      { id: "older-open", role: "assistant", content: "", process: { endedAt: undefined } },
      { id: "user", role: "user", content: "continue" },
      { id: "current", role: "assistant", content: "最终正文", isStreaming: false, process: { endedAt: undefined } },
    ], true)).toBeNull();
    expect(getActiveAssistantTurnId([
      { id: "older-open", role: "assistant", content: "", process: { endedAt: undefined } },
      { id: "current", role: "assistant", content: "最终正文", isStreaming: false, process: { endedAt: undefined } },
    ], true)).toBeNull();
  });

  it("keeps a streaming final body and commentary-only work active", () => {
    expect(getActiveAssistantTurnId([{
      id: "body-stream",
      role: "assistant",
      content: "正在流式输出正文",
      isStreaming: true,
      process: { endedAt: undefined },
    }], true)).toBe("body-stream");

    expect(getActiveAssistantTurnId([{
      id: "commentary-only",
      role: "assistant",
      content: "",
      isStreaming: false,
      process: { endedAt: undefined },
      commentary: [{ content: "这只是中间说明", isStreaming: false }],
    }], true)).toBe("commentary-only");
  });

  it("does not let stale streaming commentary override an emitted final body", () => {
    expect(getActiveAssistantTurnId([{
      id: "final-with-stale-commentary",
      role: "assistant",
      content: "最终正文",
      isStreaming: false,
      process: { endedAt: undefined },
      commentary: [{ content: "中间说明", isStreaming: true }],
    }], true)).toBeNull();
  });

  it("does not revive an older process behind a newer terminal assistant", () => {
    expect(getActiveAssistantTurnId([{
      id: "older-open",
      role: "assistant",
      content: "",
      process: { endedAt: undefined },
    }, {
      id: "newer-terminal",
      role: "assistant",
      content: "",
      process: { endedAt: 2_000 },
    }], true)).toBeNull();
  });

  it("does not let stale commentary outlive a terminal process", () => {
    expect(getActiveAssistantTurnId([{
      id: "ended-process",
      role: "assistant",
      content: "",
      process: { endedAt: 2_000 },
      commentary: [{ isStreaming: true }],
    }], true)).toBeNull();
    expect(getActiveAssistantTurnId([{
      id: "commentary-only",
      role: "assistant",
      content: "",
      commentary: [{ isStreaming: true }],
    }], true)).toBe("commentary-only");
  });

  it("does not let a stale message streaming flag outlive a terminal process", () => {
    expect(getActiveAssistantTurnId([{
      id: "ended-stream",
      role: "assistant",
      content: "",
      isStreaming: true,
      process: { endedAt: 2_000 },
    }], true)).toBeNull();
  });

  it("does not assign a later running compaction to an older assistant process", () => {
    expect(getActiveAssistantTurnId([{
      id: "orphaned-assistant",
      role: "assistant",
      content: "",
      timestamp: 1_000,
      process: { endedAt: undefined },
    }, {
      id: "compaction",
      role: "system",
      timestamp: 2_000,
      systemType: "context_compaction",
      compactionState: "running",
    }], true)).toBeNull();
  });

  it("keeps completed and interrupted compaction dividers as terminal turn boundaries", () => {
    for (const compactionState of ["completed", "interrupted"] as const) {
      expect(getActiveAssistantTurnId([{
        id: "orphaned-assistant",
        role: "assistant",
        content: "",
        timestamp: 1_000,
        process: { endedAt: undefined },
      }, {
        id: `compaction-${compactionState}`,
        role: "system",
        timestamp: 2_000,
        systemType: "context_compaction",
        compactionState,
      }], true)).toBeNull();
    }
  });

  it("settles phase-only started entries when their owning turn is terminal", () => {
    const settled = normalizeProcessForView({
      startedAt: 1_000,
      entries: [entry({
        id: "phase-only-tool",
        type: "tool",
        title: "started without a normalized state",
        phase: "started",
        timestamp: 2_000,
      })],
    }, { running: false });

    expect(settled.entries[0]).toMatchObject({
      state: "completed",
      phase: "completed",
      completedAt: 2_000,
    });
    expect(settled.endedAt).toBe(2_000);
  });

  it("keeps a continuation active when it began after the trailing compaction divider", () => {
    expect(getActiveAssistantTurnId([{
      id: "continuation",
      role: "assistant",
      content: "",
      timestamp: 3_000,
      process: { endedAt: undefined },
    }, {
      id: "compaction",
      role: "system",
      timestamp: 2_000,
      systemType: "context_compaction",
      compactionState: "running",
    }], true)).toBe("continuation");
  });

  it("recognizes, groups, and splits consecutive commands", () => {
    const entries = [
      entry({ id: "one", type: "tool", title: "正在运行 git", detail: "$ git status\nclean", state: "completed" }),
      entry({ id: "two", type: "tool", title: "command", toolKind: "run_command", command: "npm test", state: "running" }),
      entry({ id: "three", type: "status", title: "完成", state: "completed" }),
    ];
    expect(isCommandProcessEntry(entries[0])).toBe(true);
    expect(groupProcessEntries(entries).map((group) => group.kind)).toEqual(["commands", "entry"]);
    expect(splitCommandDetail(entries[0])).toEqual({ command: "git status", output: "clean" });
    expect(getProcessGroupState(entries.slice(0, 2))).toBe("running");
  });

  it("reports a non-zero command group as a warning", () => {
    expect(getProcessGroupState([
      entry({ id: "warning", type: "tool", title: "non-zero", state: "warning", exitCode: 1 }),
      entry({ id: "ok", type: "tool", title: "ok", state: "completed", exitCode: 0 }),
    ])).toBe("warning");
  });

  it("groups consecutive file operations by operation type when requested", () => {
    const entries = [
      entry({ id: "one", type: "tool", title: "已读取 1 个文件", toolKind: "read_file", files: [{ file: "a.ts" }] }),
      entry({ id: "two", type: "tool", title: "已读取 1 个文件", toolKind: "read_file", files: [{ file: "b.ts" }] }),
      entry({ id: "three", type: "tool", title: "已编辑 1 个文件", toolKind: "edit_file", files: [{ file: "b.ts" }] }),
    ];

    const groups = groupProcessEntries(entries, { groupFileOperations: true });
    expect(groups.map((group) => group.kind)).toEqual(["files", "files"]);
    expect(groups[0].kind === "files" && groups[0].entries).toHaveLength(2);
  });

  it("keeps agent narration with content, filters empty markers, and reports interruption", () => {
    const entries = [
      entry({ id: "body", type: "info", kind: ASSISTANT_NARRATION_PROCESS_KIND, title: "任意标题" }),
      entry({ id: "narration", type: "info", kind: ASSISTANT_NARRATION_PROCESS_KIND, title: "任意标题", detail: "我先检查项目配置。" }),
      entry({ id: "received", type: "status", toolKind: "message_received", title: "收到消息" }),
      entry({ id: "legacy-received", type: "status", title: "收到消息: 测试" }),
      entry({ id: "stop", type: "status", title: "用户已手动中断", state: "interrupted" }),
    ];
    expect(getVisibleProcessEntries(entries).map((item) => item.id)).toEqual(["narration", "stop"]);
    expect(isProcessInterrupted(entries)).toBe(true);
  });

  it("recognizes current and legacy guidance process entries", () => {
    const current = entry({
      id: "guidance-current",
      type: "info",
      kind: "user_guidance",
      toolKind: "guidance_message",
      title: "引导",
      detail: "继续检查这个文件",
    });
    const legacy = entry({
      id: "guidance-legacy",
      type: "status",
      title: '收到引导: "继续检查旧记录"',
    });

    expect(isUserGuidanceProcessEntry(current)).toBe(true);
    expect(getUserGuidanceText(current)).toBe("继续检查这个文件");
    expect(isUserGuidanceProcessEntry(legacy)).toBe(true);
    expect(getUserGuidanceText(legacy)).toBe("继续检查旧记录");
  });
});
