import { describe, expect, it } from "vitest";
import {
  ASSISTANT_NARRATION_PROCESS_KIND,
  formatProcessDuration,
  getUserGuidanceText,
  getActiveAssistantTurnId,
  getProcessGroupState,
  getSubagentActivityLabel,
  getSubagentProgressLabel,
  getStreamIdleNoticeDuration,
  getVisibleProcessEntries,
  hasNativeMultiStepProcessPlan,
  groupProcessEntries,
  isCommandProcessEntry,
  isProcessInterrupted,
  isProcessViewRunning,
  getConciseProcessEntries,
  isUserGuidanceProcessEntry,
  collapseOperationProcessEntries,
  mergeThinkingEntries,
  OPERATION_SUMMARY_TOOL_KIND,
  normalizeProcessForView,
  splitCommandDetail,
  type ProcessEntryView,
} from "./process-view";

const entry = (patch: Partial<ProcessEntryView> & Pick<ProcessEntryView, "id" | "type" | "title">): ProcessEntryView => patch;

describe("shared process view model", () => {
  it("only treats native plans with multiple steps as floating Todo summaries", () => {
    expect(hasNativeMultiStepProcessPlan({ planStepsSource: "native", planSteps: [{ status: "running" }] })).toBe(false);
    expect(hasNativeMultiStepProcessPlan({
      planStepsSource: "native",
      planSteps: [{ status: "completed" }, { status: "running" }],
    })).toBe(true);
    expect(hasNativeMultiStepProcessPlan({ planStepsSource: "inferred", planSteps: [{ status: "completed" }, { status: "running" }] })).toBe(false);
  });

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
      entry({ id: "body", type: "info", kind: "assistant_narration", title: "任意标题" }),
      entry({ id: "narration", type: "info", kind: "assistant_narration", title: "任意标题", detail: "我先检查项目配置。" }),
      entry({ id: "received", type: "status", toolKind: "message_received", title: "收到消息" }),
      entry({ id: "legacy-received", type: "status", title: "收到消息: 测试" }),
      entry({ id: "stop", type: "status", title: "用户已手动中断", state: "interrupted" }),
    ];
    expect(getVisibleProcessEntries(entries).map((item) => item.id)).toEqual(["narration", "stop"]);
    expect(isProcessInterrupted(entries)).toBe(true);
  });

  it("merges repeated stream idle notices and sums their durations", () => {
    const durations = [54_000, 137_000, 107_000, 121_000];
    const entries = durations.map((duration, index) => {
      const startedAt = index * 200_000;
      return entry({
        id: `idle-${index}`,
        type: "status",
        title: "Pi 仍在运行，暂时没有新输出",
        toolKind: "stream_idle_notice",
        state: "completed",
        timestamp: startedAt,
        startedAt,
        completedAt: startedAt + duration,
      });
    });

    const [merged] = getVisibleProcessEntries(entries);

    expect(getVisibleProcessEntries(entries)).toHaveLength(1);
    expect(merged.id).toBe("idle-3");
    expect(merged.accumulatedDurationMs).toBe(54_000 + 137_000 + 107_000);
    expect(getStreamIdleNoticeDuration(merged, 999_999)).toBe(419_000);
  });

  it("reports subagent completion and latest live activity", () => {
    const subagents = [
      { id: "scout", label: "Scout", status: "running" as const, message: "正在读取文件" },
      { id: "reviewer", label: "Reviewer", status: "completed" as const, message: "已完成" },
    ];

    expect(getSubagentProgressLabel(subagents)).toBe("进度 1/2");
    expect(getSubagentActivityLabel(subagents)).toBe("Scout：正在读取文件");
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

  // 旧数据可能只剩发给 Agent 的信封 XML，不能在引导气泡里原样显示。
  it("normalizes internal envelope tags in guidance detail", () => {
    expect(getUserGuidanceText(entry({
      id: "guidance-envelope",
      type: "status",
      title: "引导",
      detail: '看下旧项目\n<folder path="C:\\Project\\EchoMusicMobile" />',
    }))).toBe("看下旧项目\n[folder: EchoMusicMobile]");

    expect(getUserGuidanceText(entry({
      id: "guidance-envelope-file",
      type: "status",
      title: "引导",
      detail: '<file path="G:\\Work\\src\\main.ts" lines="2-3">\ncode\n</file>',
    }))).toBe("[file: main.ts:2-3]");
  });
});

describe("mergeThinkingEntries", () => {
  const thinking = (id: string, detail: string, timestamp: number): ProcessEntryView => ({
    id,
    type: "thinking",
    title: "正在思考",
    detail,
    timestamp,
    state: "completed",
  });
  const tool = (id: string, timestamp: number): ProcessEntryView => ({
    id,
    type: "tool",
    title: "已运行命令",
    timestamp,
    state: "completed",
  });

  it("joins consecutive thinking entries into one", () => {
    const merged = mergeThinkingEntries([
      thinking("t1", "第一段。", 10),
      thinking("t2", "第二段。", 20),
      thinking("t3", "第三段。", 30),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("t1");
    expect(merged[0].detail).toBe("第一段。\n\n第二段。\n\n第三段。");
    expect(merged[0].timestamp).toBe(10);
  });

  it("keeps groups separated by any non-thinking entry", () => {
    const merged = mergeThinkingEntries([
      thinking("t1", "前一段。", 10),
      thinking("t2", "紧邻的一段。", 20),
      tool("x", 30),
      thinking("t3", "后一段。", 40),
    ]);

    expect(merged).toHaveLength(3);
    expect(merged[0].detail).toBe("前一段。\n\n紧邻的一段。");
    expect(merged[1].id).toBe("x");
    expect(merged[2].detail).toBe("后一段。");
  });

  it("leaves non-thinking-only lists untouched and dedupes identical text", () => {
    expect(mergeThinkingEntries([tool("x", 1), tool("y", 2)])).toHaveLength(2);

    const merged = mergeThinkingEntries([
      thinking("t1", "重复内容。", 10),
      thinking("t2", "重复内容。", 20),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].detail).toBe("重复内容。");
  });

  it("dedupes by paragraph so a repeated later chunk is not appended twice", () => {
    // 流式快照会重复下发同一段思考：A、B、B 不能拼成 "A\n\nB\n\nB"。
    const merged = mergeThinkingEntries([
      thinking("t1", "A 段。", 10),
      thinking("t2", "B 段。", 20),
      thinking("t3", "B 段。", 30),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].detail).toBe("A 段。\n\nB 段。");

    // 多行合并后再来一条重复段落，仍然不重复拼接。
    const chained = mergeThinkingEntries([
      { ...thinking("t1", "A 段。\n\nB 段。", 10) },
      thinking("t2", "B 段。", 20),
    ]);
    expect(chained[0].detail).toBe("A 段。\n\nB 段。");
  });

  it("keeps the previous state when the later entry has none", () => {
    const previous = { ...thinking("t1", "第一段。", 10), state: "running" as const };
    const next = { ...thinking("t2", "第二段。", 20), state: undefined };
    const [merged] = mergeThinkingEntries([previous, next]);
    expect(merged.state).toBe("running");
  });
});

describe("getConciseProcessEntries", () => {
  const base = { title: "条目", timestamp: 1 } as const;
  const view = (over: Partial<ProcessEntryView> & { id: string; type: ProcessEntryView["type"] }) =>
    ({ ...base, ...over }) as ProcessEntryView;

  it("keeps thinking, guidance, questionnaire and error entries", () => {
    const entries = [
      view({ id: "t", type: "thinking", detail: "思考", title: "正在思考" }),
      view({ id: "g", type: "info", kind: "user_guidance", toolKind: "guidance_message", detail: "引导" }),
      view({ id: "q", type: "question", title: "需要确认" }),
      view({ id: "e", type: "error", title: "执行失败" }),
      view({ id: "n", type: "info", kind: "assistant_narration", title: "说明", detail: "正文" }),
    ];

    expect(getConciseProcessEntries(entries).map((entry) => entry.id)).toEqual(["t", "g", "q", "e", "n"]);
  });

  it("drops only operation entries and keeps everything else", () => {
    const entries = [
      view({ id: "c", type: "tool", toolKind: "run_command", title: "已运行 1 条命令", detail: "npm test" }),
      view({ id: "f", type: "tool", toolKind: "read_file", title: "已读取 1 个文件" }),
      view({ id: "d", type: "diff", title: "变更" }),
      // 状态、子 Agent、空闲提示都不是“运行了什么”，必须保留。
      view({ id: "s", type: "status", title: "状态" }),
      view({ id: "a", type: "subagent", title: "子 Agent" }),
      view({ id: "i", type: "tool", toolKind: "stream_idle_notice", title: "无输出" }),
      view({ id: "t", type: "thinking", title: "正在思考", detail: "保留我" }),
    ];

    expect(getConciseProcessEntries(entries).map((entry) => entry.id)).toEqual(["s", "a", "i", "t"]);
  });
});

describe("collapseOperationProcessEntries", () => {
  const base = { title: "条目", timestamp: 1 } as const;
  const view = (over: Partial<ProcessEntryView> & { id: string; type: ProcessEntryView["type"] }) =>
    ({ ...base, ...over }) as ProcessEntryView;

  it("merges commands, viewed files and changed files into one line", () => {
    const collapsed = collapseOperationProcessEntries([
      view({ id: "t", type: "thinking", title: "思考", detail: "想一下" }),
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "已运行 1 条命令", command: "npm test" }),
      view({ id: "r1", type: "tool", toolKind: "read_file", title: "已读取 2 个文件", files: ["a.ts", "b.ts"] }),
      view({ id: "d1", type: "diff", title: "变更", files: ["x.ts"] }),
      view({ id: "q", type: "question", title: "需要确认" }),
    ]);

    expect(collapsed.map((entry) => entry.type)).toEqual(["thinking", "status", "question"]);
    const summary = collapsed[1];
    expect(summary.toolKind).toBe(OPERATION_SUMMARY_TOOL_KIND);
    expect(summary.title).toBe("运行 1 条命令 · 查看 2 个文件 · 修改 1 个文件");
    // 合成条目的 id 跟着首个操作走，列表 key 稳定。
    expect(summary.id).toBe("c1-operation-summary");
  });

  it("leaves entry lists without operations untouched", () => {
    const entries = [
      view({ id: "t", type: "thinking", title: "思考", detail: "想一下" }),
      view({ id: "q", type: "question", title: "需要确认" }),
    ];
    expect(collapseOperationProcessEntries(entries)).toBe(entries);
  });

  it("marks the summary as running while any operation is running", () => {
    const collapsed = collapseOperationProcessEntries([
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test", state: "running" }),
      view({ id: "d1", type: "diff", title: "变更", files: ["x.ts"], state: "completed" }),
    ]);
    expect(collapsed[0].state).toBe("running");
  });
});

describe("collapseOperationProcessEntries 的明细", () => {
  const base = { title: "条目", timestamp: 1 } as const;
  const view = (over: Partial<ProcessEntryView> & { id: string; type: ProcessEntryView["type"] }) =>
    ({ ...base, ...over }) as ProcessEntryView;

  it("keeps grouped details so the renderer can expand them", () => {
    const [summary] = collapseOperationProcessEntries([
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test" }),
      view({ id: "c2", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm run build" }),
      view({ id: "w1", type: "tool", toolKind: "edit_file", title: "编辑", files: [{ file: "src/a.cs", action: "edited" }] }),
      view({ id: "d1", type: "diff", title: "变更", files: [{ file: "src/b.cs" }] }),
      view({ id: "r1", type: "tool", toolKind: "read_file", title: "读取", files: [{ file: "src/c.cs", action: "read" }] }),
    ]);

    // 标题仍是合并后的一行。
    expect(summary.title).toBe("运行 2 条命令 · 查看 1 个文件 · 修改 2 个文件");
    // 明细按类别分好，展开时直接渲染（文件名可点击）。
    expect(summary.operationSummary).toEqual({
      commandCount: 2,
      changedFiles: ["src/a.cs", "src/b.cs"],
      viewedFiles: ["src/c.cs"],
    });
  });
});
