import { describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/stores/chat-store";
import type { AgentEventRuntimeController } from "./agentEventTypes";
import { dispatchAgentEvent, mergeHistoryCommentary, parseHistorySnapshotMessages } from "./agentEventDispatcher";

describe("parseHistorySnapshotMessages", () => {
  it("restores commentary attached to a completed assistant message", () => {
    const messages = parseHistorySnapshotMessages([
      { id: "user-1", role: "user", content: "发布版本", timestamp: 1 },
      {
        id: "assistant-1",
        role: "assistant",
        content: "版本已经发布。",
        timestamp: 4,
        commentary: [
          { id: "note-1", content: "我先检查发布配置。", timestamp: 2 },
          { id: "note-2", content: "现在开始构建。", timestamp: 3 },
        ],
      },
    ]);

    expect(messages[1]).toMatchObject({
      content: "版本已经发布。",
      commentary: [
        { id: "note-1", content: "我先检查发布配置。", isStreaming: false },
        { id: "note-2", content: "现在开始构建。", isStreaming: false },
      ],
    });
  });

  it("folds phase commentary records into the following final answer", () => {
    const messages = parseHistorySnapshotMessages([
      { id: "user-1", role: "user", content: "修复问题", timestamp: 1 },
      {
        id: "note-1",
        itemId: "commentary-item-1",
        role: "assistant",
        phase: "commentary",
        content: "我会先定位事件流。",
        timestamp: 2,
      },
      {
        id: "assistant-1",
        role: "assistant",
        phase: "final_answer",
        content: "问题已修复。",
        timestamp: 3,
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: "assistant-1",
      content: "问题已修复。",
      commentary: [{
        id: "commentary-item-1",
        content: "我会先定位事件流。",
        isStreaming: false,
      }],
    });
  });

  it("backfills commentary into a persisted assistant turn without replacing local data", () => {
    const existing = [{
      id: "local-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      process: { startedAt: 1, endedAt: 4, entries: [] },
    }];
    const recovered = [{
      id: "history-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      commentary: [{ id: "note-1", content: "working", timestamp: 2 }],
    }];

    const merged = mergeHistoryCommentary(existing, recovered);

    expect(merged[0]).toMatchObject({
      id: "local-assistant",
      process: existing[0].process,
      commentary: [{ id: "note-1", content: "working", timestamp: 2, isStreaming: false }],
    });
  });

  it("does not duplicate persisted commentary whose history id is different", () => {
    const existing = [{
      id: "local-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      commentary: [{ id: "live-item-id", content: "working", timestamp: 2 }],
    }];
    const recovered = [{
      id: "history-assistant",
      role: "assistant" as const,
      content: "done",
      timestamp: 4,
      nativeTurnId: "turn-1",
      commentary: [{ id: "history-item-id", content: "working", timestamp: 2.1 }],
    }];

    expect(mergeHistoryCommentary(existing, recovered)).toBe(existing);
  });

  it("restores a commentary-only interrupted turn after its persisted user message", () => {
    const existing = [{
      id: "local-user",
      role: "user" as const,
      content: "investigate",
      timestamp: 1,
      nativeTurnId: "turn-interrupted",
    }];
    const recovered = [{
      id: "history-commentary-only",
      role: "assistant" as const,
      content: "",
      timestamp: 2,
      nativeTurnId: "turn-interrupted",
      commentary: [{ id: "note-1", content: "I found the cause.", timestamp: 2 }],
    }];

    expect(mergeHistoryCommentary(existing, recovered)).toEqual([
      existing[0],
      recovered[0],
    ]);
  });
});

describe("dispatchAgentEvent subagent lifecycle", () => {
  it("adds a subagent event to the assistant process timeline", () => {
    const appendProcessEntry = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false }),
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      ensureAssistantContinuation: vi.fn(),
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      appendProcessEntry,
    } as unknown as AgentEventRuntimeController;

    dispatchAgentEvent({
      type: "subagent_event",
      sessionId: "session-1",
      id: "spawn-1",
      title: "已开始工作",
      state: "running",
      subagents: [{ id: "thread-1", label: "Backend", status: "running" }],
    }, controller);

    expect(appendProcessEntry).toHaveBeenCalledWith("session-1", expect.objectContaining({
      id: "spawn-1",
      type: "subagent",
      title: "已开始工作",
      state: "running",
      subagents: [expect.objectContaining({ id: "thread-1", label: "Backend" })],
    }));
  });
});

describe("dispatchAgentEvent background subagents", () => {
  it("updates the original process entry instead of opening a new assistant turn", () => {
    const seeded = {
      id: "message-1",
      role: "assistant" as const,
      content: "",
      timestamp: 1,
      isStreaming: false,
      process: {
        startedAt: 1,
        endedAt: 2,
        entries: [{
          id: "call-bg",
          type: "subagent" as const,
          title: "正在工作",
          timestamp: 1,
          state: "running" as const,
          subagents: [{
            id: "sa_1:1",
            label: "后台",
            status: "running" as const,
            background: true,
            taskId: "sa_1",
            message: "旧进度",
          }],
        }],
      },
    };
    useChatStore.setState({
      activeSessionId: "session-1",
      messages: [seeded],
      sessionMessages: { "session-1": [seeded] },
    });

    const appendProcessEntry = vi.fn();
    const ensureAssistantContinuation = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false, turnEventState: "settled" }),
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      ensureAssistantContinuation,
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      appendProcessEntry,
    } as unknown as AgentEventRuntimeController;

    dispatchAgentEvent({
      type: "subagent_event",
      sessionId: "session-1",
      id: "call-bg",
      background: true,
      phase: "started",
      state: "running",
      lifecycleRevision: "backend:bg:1",
      clientUserMessageId: "host:host:1",
      subagents: [{
        id: "sa_1:1",
        label: "后台",
        status: "running",
        background: true,
        taskId: "sa_1",
        message: "新进度",
      }],
    }, controller);

    // 不新开助手消息、不追加新条目；只更新原来的 process entry。
    expect(ensureAssistantContinuation).not.toHaveBeenCalled();
    expect(appendProcessEntry).not.toHaveBeenCalled();
    const updated = useChatStore.getState().sessionMessages["session-1"][0]
      .process?.entries[0].subagents?.[0];
    expect(updated).toMatchObject({ id: "sa_1:1", status: "running", message: "新进度" });
  });
});

describe("dispatchAgentEvent host turn", () => {
  it("creates an assistant-only turn with a system hint for auto-wake", () => {
    const appendProcessEntry = vi.fn();
    const ensureAssistantContinuation = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false }),
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      ensureAssistantContinuation,
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      appendProcessEntry,
    } as unknown as AgentEventRuntimeController;

    dispatchAgentEvent({
      type: "host_turn_started",
      sessionId: "session-1",
      id: "host:1",
      reason: "subagent_result",
      taskIds: ["sa_1", "sa_2"],
      lifecycleRevision: "backend:1",
      clientUserMessageId: "host:host:1",
    }, controller);

    expect(ensureAssistantContinuation).toHaveBeenCalledWith("session-1");
    expect(appendProcessEntry).toHaveBeenCalledWith("session-1", expect.objectContaining({
      id: "host-turn-host:1",
      type: "status",
      title: "后台任务已完成，Agent 自动继续",
      detail: "任务：sa_1、sa_2",
      state: "completed",
    }));
  });
});

describe("dispatchAgentEvent auto compaction failure", () => {
  it("leaves a visible divider carrying the backend reason", () => {
    const appendContextCompactionDivider = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false }),
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      appendContextCompactionDivider,
    } as unknown as AgentEventRuntimeController;

    // 自动压缩失败是静默路径：必须落一条可见记录，且带上真实原因。
    dispatchAgentEvent({
      type: "auto_compaction_failed",
      sessionId: "session-1",
      message: "SESSION_BUSY",
    } as unknown as Parameters<typeof dispatchAgentEvent>[0], controller);

    expect(appendContextCompactionDivider).toHaveBeenCalledWith(
      "session-1",
      undefined,
      "failed",
      undefined,
      "SESSION_BUSY",
    );
  });

  it("carries the backend reason for a failed compaction into the divider", () => {
    const appendContextCompactionDivider = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false }),
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      appendContextCompactionDivider,
    } as unknown as AgentEventRuntimeController;

    // 后端自己报的失败（context_compaction failed）也要带上原因：
    // 只写「上下文压缩失败」等于把最有用的那部分丢了。
    dispatchAgentEvent({
      type: "context_compaction",
      sessionId: "session-1",
      id: "c1",
      phase: "failed",
      detail: "upstream 429",
    } as unknown as Parameters<typeof dispatchAgentEvent>[0], controller);

    expect(appendContextCompactionDivider).toHaveBeenCalledWith(
      "session-1",
      "c1",
      "failed",
      undefined,
      "upstream 429",
    );
  });
});

describe("dispatchAgentEvent background plan updates", () => {
  it("空闲态只更新既有计划，不新开助手回合", () => {
    const ensureAssistantContinuation = vi.fn();
    const updateProcessPlanSteps = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => ({ manualAbortRequested: false, processActive: false, streamStarted: false }),
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      ensureAssistantContinuation,
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      updateProcessPlanSteps,
      appendProcessEntry: vi.fn(),
    } as unknown as AgentEventRuntimeController;

    // 后台任务在主回合结束后改 todo：只把计划写回既有消息，
    // 否则每条 plan_update 都会新建一个空气泡并多一次完成通知。
    dispatchAgentEvent({
      type: "plan_update",
      sessionId: "session-1",
      background: true,
      steps: [{ id: "1", title: "收尾", status: "completed" }],
    } as unknown as Parameters<typeof dispatchAgentEvent>[0], controller);

    expect(ensureAssistantContinuation).not.toHaveBeenCalled();
    expect(updateProcessPlanSteps).toHaveBeenCalledWith(
      "session-1",
      [expect.objectContaining({ id: "1", status: "completed" })],
      true,
      { createIfMissing: false },
    );
  });

  it("主回合 settled 且 revision 已归档时仍接受 background plan_update", () => {
    // 模拟真实时序：主回合已结算，registry 仍带着旧 revision 发后台计划更新。
    // 旧门禁会因为 isSettledTurnRevision 返回 false 直接丢掉它。
    const runtime = {
      manualAbortRequested: false,
      processActive: false,
      streamStarted: false,
      turnEventState: "settled",
      activeTurnRevision: "r2",
      settledTurnRevisions: ["r1"],
    };
    const updateProcessPlanSteps = vi.fn();
    const ensureAssistantContinuation = vi.fn();
    const controller = {
      isOpenProjectSession: () => true,
      getRuntime: () => runtime,
      cancelAgentEndGrace: vi.fn(),
      refreshStreamWatchdog: vi.fn(),
      ensureAssistantContinuation,
      finishAssistantProcessText: vi.fn(),
      finishThinkingEntry: vi.fn(),
      updateInferredPlanSteps: vi.fn(),
      updateProcessPlanSteps,
      appendProcessEntry: vi.fn(),
    } as unknown as AgentEventRuntimeController;

    dispatchAgentEvent({
      type: "plan_update",
      sessionId: "session-1",
      background: true,
      lifecycleRevision: "r1",
      steps: [{ id: "1", title: "收尾", status: "completed" }],
    } as unknown as Parameters<typeof dispatchAgentEvent>[0], controller);

    expect(ensureAssistantContinuation).not.toHaveBeenCalled();
    expect(updateProcessPlanSteps).toHaveBeenCalledWith(
      "session-1",
      [expect.objectContaining({ id: "1" })],
      true,
      { createIfMissing: false },
    );
  });
});
