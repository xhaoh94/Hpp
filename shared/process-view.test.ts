import { describe, expect, it } from "vitest";
import {
  ASSISTANT_NARRATION_PROCESS_KIND,
  formatProcessDuration,
  getUserGuidanceText,
  getActiveAssistantTurnId,
  getProcessGroupState,
  getSubagentActivityLabel,
  getSubagentProgressLabel,
  getEffectiveProcessSubagents,
  getVisibleProcessEntries,
  hasNativeMultiStepProcessPlan,
  groupProcessEntries,
  isCommandProcessEntry,
  isProcessInterrupted,
  isProcessViewRunning,
  getConciseProcessEntries,
  buildConciseCommentaryEntry,
  isUserGuidanceProcessEntry,
  collapseOperationProcessEntries,
  collapseStandardProcessEntries,
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

  it("merges thinking and body into two blocks, keeping interactive entries as boundaries", () => {
    const entries = [
      view({ id: "t1", type: "thinking", detail: "先看设置", title: "正在思考", timestamp: 1 }),
      view({ id: "c", type: "tool", toolKind: "run_command", title: "已运行 1 条命令", detail: "npm test", timestamp: 2 }),
      view({ id: "t2", type: "thinking", detail: "再看缓存", title: "正在思考", timestamp: 3 }),
      view({ id: "n1", type: "info", kind: "assistant_narration", title: "说明", detail: "第一段正文", timestamp: 4 }),
      view({ id: "n2", type: "info", kind: "assistant_narration", title: "说明", detail: "第二段正文", timestamp: 5 }),
    ];

    const concise = getConciseProcessEntries(entries);
    expect(concise.map((entry) => entry.id)).toEqual(["t1", "n1"]);
    expect(concise[0].detail).toBe("先看设置\n\n再看缓存");
    expect(concise[1].detail).toBe("第一段正文\n\n第二段正文");
  });

  it("keeps guidance, questionnaire and error in place instead of merging across them", () => {
    const entries = [
      view({ id: "t1", type: "thinking", detail: "改之前", title: "正在思考", timestamp: 1 }),
      view({ id: "g", type: "info", kind: "user_guidance", toolKind: "guidance_message", detail: "改成用缓存", timestamp: 2 }),
      view({ id: "t2", type: "thinking", detail: "改之后", title: "正在思考", timestamp: 3 }),
      view({ id: "q", type: "question", title: "需要确认", timestamp: 4 }),
      view({ id: "e", type: "error", title: "执行失败", timestamp: 5 }),
      view({ id: "n", type: "info", kind: "assistant_narration", title: "说明", detail: "正文", timestamp: 6 }),
    ];

    expect(getConciseProcessEntries(entries).map((entry) => entry.id)).toEqual(["t1", "g", "t2", "q", "e", "n"]);
  });

  it("shows diff but hides operation, status and subagent entries", () => {
    const entries = [
      view({ id: "c", type: "tool", toolKind: "run_command", title: "已运行 1 条命令", detail: "npm test" }),
      view({ id: "f", type: "tool", toolKind: "read_file", title: "已读取 1 个文件" }),
      view({ id: "s", type: "status", title: "状态" }),
      view({ id: "d", type: "diff", title: "变更" }),
      view({
        id: "a", type: "subagent", title: "子 Agent", detail: "子任务正文",
        subagents: [{ id: "s1", label: "Scout", message: "子任务消息", status: "completed" }],
      }),
      view({ id: "e", type: "error", title: "出错了" }),
      view({ id: "t", type: "thinking", title: "正在思考", detail: "保留我" }),
    ];

    // subagent 胶囊只在底部悬浮区（与档位无关）显示，处理过程时间线内不出现。
    const concise = getConciseProcessEntries(entries);
    expect(concise.map((entry) => entry.id)).toEqual(["d", "e", "t"]);
    expect(concise.some((entry) => entry.type === "subagent")).toBe(false);
  });

  it("folds standalone commentary into one narration entry", () => {
    const folded = buildConciseCommentaryEntry<ProcessEntryView>([
      { id: "c1", content: "第一段", timestamp: 10 },
      { id: "c2", content: "第一段\n\n第二段", timestamp: 20, isStreaming: true },
    ]);

    expect(folded?.kind).toBe(ASSISTANT_NARRATION_PROCESS_KIND);
    expect(folded?.detail).toBe("第一段\n\n第二段");
    expect(folded?.timestamp).toBe(10);
    expect(folded?.state).toBe("running");
    expect(buildConciseCommentaryEntry([])).toBeNull();
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

  // 只有连续的操作才合并：思考/正文/提示打断时重新起一段，否则会分不清
  // "这段回话到底跑了什么"。
  it("splits merged operations at intervening thinking or narration entries", () => {
    const collapsed = collapseOperationProcessEntries([
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test" }),
      view({ id: "c2", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm run lint" }),
      view({ id: "t1", type: "thinking", title: "思考", detail: "先看看测试结果" }),
      view({ id: "c3", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm run build" }),
      view({ id: "n1", type: "info", kind: ASSISTANT_NARRATION_PROCESS_KIND, title: "正文" }),
      view({ id: "c4", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm run deploy" }),
    ]);

    expect(collapsed.map((item) => item.id)).toEqual([
      "c1-operation-summary",
      "t1",
      "c3-operation-summary",
      "n1",
      "c4-operation-summary",
    ]);
    expect(collapsed[0].title).toBe("运行 2 条命令");
    expect(collapsed[2].title).toBe("运行 1 条命令");
    expect(collapsed[4].title).toBe("运行 1 条命令");
  });

  it("starts a new run after an error entry", () => {
    const collapsed = collapseOperationProcessEntries([
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test" }),
      view({ id: "err", type: "error", title: "命令失败" }),
      view({ id: "c2", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm run build" }),
    ]);

    expect(collapsed.map((item) => item.id)).toEqual([
      "c1-operation-summary",
      "err",
      "c2-operation-summary",
    ]);
  });

  it("marks the summary as running while any operation is running", () => {
    const collapsed = collapseOperationProcessEntries([
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test", state: "running" }),
      view({ id: "d1", type: "diff", title: "变更", files: ["x.ts"], state: "completed" }),
    ]);
    expect(collapsed[0].state).toBe("running");
  });
});

describe("collapseStandardProcessEntries", () => {
  const base = { title: "条目", timestamp: 1 } as const;
  const view = (over: Partial<ProcessEntryView> & { id: string; type: ProcessEntryView["type"] }) =>
    ({ ...base, ...over }) as ProcessEntryView;

  // 标准模式：正文之间的思考先合成一块，命令/查看/修改再合成一块。
  it("merges thinking and operations into one block per segment", () => {
    const collapsed = collapseStandardProcessEntries([
      view({ id: "t1", type: "thinking", title: "思考", detail: "先看看现状" }),
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test" }),
      view({ id: "t2", type: "thinking", title: "思考", detail: "再补一次校验" }),
      view({ id: "r1", type: "tool", toolKind: "read_file", title: "读取", files: [{ file: "a.ts" }] }),
      view({ id: "n1", type: "info", kind: ASSISTANT_NARRATION_PROCESS_KIND, title: "正文" }),
      view({ id: "t3", type: "thinking", title: "思考", detail: "收尾" }),
      view({ id: "c2", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm run build" }),
    ]);

    expect(collapsed.map((item) => item.id)).toEqual([
      "t1",
      "c1-operation-summary",
      "n1",
      "t3",
      "c2-operation-summary",
    ]);
    // 两段思考的正文合到第一条里。
    expect(collapsed[0].detail).toBe("先看看现状\n\n再补一次校验");
    expect(collapsed[1].title).toBe("运行 1 条命令 · 查看 1 个文件");
  });

  // 摘要展开时要逐条列出命令：description 是标题，command 放进 title。
  it("keeps each command and its description inside the summary", () => {
    const [summary] = collapseStandardProcessEntries([
      view({
        id: "c1",
        type: "tool",
        toolKind: "run_command",
        title: "查看空闲时长的渲染位置",
        description: "查看空闲时长的渲染位置",
        command: "grep -rn idleDuration src",
      }),
      view({
        id: "c2",
        type: "tool",
        toolKind: "run_command",
        title: "移除两端的空闲时长渲染",
        description: "移除两端的空闲时长渲染",
        command: "sed -n 918,935p mobile/src/App.tsx",
      }),
    ]);

    expect(summary.title).toBe("运行 2 条命令");
    expect(summary.operationSummary?.commandItems).toEqual([
      { id: "c1", description: "查看空闲时长的渲染位置", command: "grep -rn idleDuration src" },
      { id: "c2", description: "移除两端的空闲时长渲染", command: "sed -n 918,935p mobile/src/App.tsx" },
    ]);
  });

  it("keeps the first-seen category order inside a segment", () => {
    const collapsed = collapseStandardProcessEntries([
      view({ id: "c1", type: "tool", toolKind: "run_command", title: "跑命令", command: "npm test" }),
      view({ id: "t1", type: "thinking", title: "思考", detail: "看结果" }),
    ]);

    // 先跑命令再思考：保持这个先后，不强行把思考提上来。
    expect(collapsed.map((item) => item.id)).toEqual(["c1-operation-summary", "t1"]);
  });

  it("lets questions and errors break the segment", () => {
    const collapsed = collapseStandardProcessEntries([
      view({ id: "t1", type: "thinking", title: "思考", detail: "A" }),
      view({ id: "q", type: "question", title: "需要确认" }),
      view({ id: "t2", type: "thinking", title: "思考", detail: "B" }),
    ]);

    expect(collapsed.map((item) => item.id)).toEqual(["t1", "q", "t2"]);
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
      // 展开摘要时每条命令单独一行，标题用 description，缺省退回命令本身。
      commandItems: [
        { id: "c1", command: "npm test" },
        { id: "c2", command: "npm run build" },
      ],
    });
  });
});

describe("getEffectiveProcessSubagents", () => {
  const child = (id: string, status?: "pending" | "running" | "completed") => ({ id, label: id, status });

  // 占位项的 id 是裸工具调用 id，真实子任务是 `toolCallId:N`；前者收不到后续事件。
  it("drops a placeholder whose id prefixes a real child", () => {
    const subagents = [child("call-1", "running"), child("call-1:1", "completed")];
    expect(getEffectiveProcessSubagents(subagents, "running").map((item) => item.id)).toEqual(["call-1:1"]);
  });

  it("drops leftover active subagents once the entry is terminal", () => {
    const subagents = [child("a", "running"), child("b", "completed")];
    expect(getEffectiveProcessSubagents(subagents, "completed").map((item) => item.id)).toEqual(["b"]);
    expect(getEffectiveProcessSubagents(subagents, "error").map((item) => item.id)).toEqual(["b"]);
    // 运行中的条目照常全部保留。
    expect(getEffectiveProcessSubagents(subagents, "running")).toHaveLength(2);
    // 老数据没有状态字段时不敢当幽灵删。
    expect(getEffectiveProcessSubagents([{ id: "x", label: "X" }], "completed")).toHaveLength(1);
  });
});
