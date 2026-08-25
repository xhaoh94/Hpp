import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "./chat-store";

describe("chat process entry defaults", () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      sessionMessages: {},
      activeSessionId: null,
      compactingSessions: {},
    });
  });

  it("keeps running command entries collapsed regardless of agent hints", () => {
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: "command",
      type: "tool",
      title: "正在运行 Execute",
      detail: "$ git status\noutput",
      toolKind: "run_command",
      command: "git status",
      timestamp: Date.now(),
      state: "running",
      expanded: true,
    });

    expect(useChatStore.getState().messages[0].process?.entries[0].expanded).toBe(false);
  });

  it("keeps other running tool entries collapsed by default", () => {
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: "search",
      type: "tool",
      title: "正在搜索",
      detail: "query",
      toolKind: "search_text",
      timestamp: Date.now(),
      state: "running",
    });

    expect(useChatStore.getState().messages[0].process?.entries[0].expanded).toBe(false);
  });

  it("leaves thinking entries expanded unset by default", () => {
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: "thinking",
      type: "thinking",
      title: "正在思考",
      detail: "**Inspecting** the project",
      timestamp: Date.now(),
      state: "running",
    });

    // 未手动操作时思考条目的 expanded 保持未设置，默认展开状态由设置
    // expandThinkingWhileRunning 决定（见 ProcessBlock）。
    expect(useChatStore.getState().messages[0].process?.entries[0].expanded).toBeUndefined();
  });

  it("collapses thinking entries when the last process is collapsed", () => {
    const store = useChatStore.getState();
    store.appendLastAssistantProcessEntry({
      id: "thinking",
      type: "thinking",
      title: "正在思考",
      detail: "**Inspecting** the project",
      timestamp: 1,
      state: "running",
    });
    store.appendLastAssistantProcessEntry({
      id: "search",
      type: "tool",
      title: "正在搜索",
      detail: "query",
      toolKind: "search_text",
      timestamp: 2,
      state: "running",
    });
    // 手动展开非思考条目，验证折叠执行过程时不受影响
    store.updateLastAssistantProcessEntry("search", { expanded: true });

    useChatStore.getState().collapseLastAssistantProcess();

    const process = useChatStore.getState().messages[0].process;
    expect(process?.expanded).toBe(false);
    expect(process?.entries.find((entry) => entry.id === "thinking")?.expanded).toBe(false);
    // 非思考条目不受影响
    expect(process?.entries.find((entry) => entry.id === "search")?.expanded).toBe(true);
  });

  it("keeps thinking entries expanded when manually toggling the process", () => {
    const store = useChatStore.getState();
    store.appendLastAssistantProcessEntry({
      id: "thinking",
      type: "thinking",
      title: "正在思考",
      detail: "**Inspecting** the project",
      timestamp: 1,
      state: "running",
    });
    const messageId = useChatStore.getState().messages[0].id;

    // 手动折叠执行过程不影响思考过程的状态（思考的展开状态由设置
    // expandThinkingWhileRunning 决定，未手动操作时 expanded 为 undefined）
    useChatStore.getState().toggleAssistantProcess(messageId);

    let process = useChatStore.getState().messages[0].process;
    expect(process?.expanded).toBe(false);
    expect(process?.entries.find((entry) => entry.id === "thinking")?.expanded).toBeUndefined();

    // 重新展开执行过程时思考过程仍保持原状态
    useChatStore.getState().toggleAssistantProcess(messageId);
    process = useChatStore.getState().messages[0].process;
    expect(process?.expanded).toBe(true);
    expect(process?.entries.find((entry) => entry.id === "thinking")?.expanded).toBeUndefined();
  });

  it("toggles thinking entries toward an explicit target state", () => {
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: "thinking",
      type: "thinking",
      title: "正在思考",
      detail: "**Inspecting** the project",
      timestamp: Date.now(),
      state: "running",
    });
    const messageId = useChatStore.getState().messages[0].id;
    const thinkingExpanded = () => (
      useChatStore.getState().messages[0].process?.entries.find((entry) => entry.id === "thinking")?.expanded
    );

    // 思考条目的显示状态可能由设置决定（expanded 未设置），因此 UI 层会
    // 显式传入目标状态：点击折叠中的思考应直接展开，而不是翻转 undefined。
    useChatStore.getState().toggleAssistantProcessEntry(messageId, "thinking", true);
    expect(thinkingExpanded()).toBe(true);

    useChatStore.getState().toggleAssistantProcessEntry(messageId, "thinking", false);
    expect(thinkingExpanded()).toBe(false);

    // 未传目标状态时保持原有翻转语义。
    useChatStore.getState().toggleAssistantProcessEntry(messageId, "thinking");
    expect(thinkingExpanded()).toBe(true);
  });

  it("keeps error details collapsed by default", () => {
    useChatStore.getState().appendLastAssistantProcessEntry({
      id: "error",
      type: "error",
      title: "执行失败",
      detail: "failure detail",
      timestamp: Date.now(),
      state: "error",
      expanded: true,
    });

    expect(useChatStore.getState().messages[0].process?.entries[0].expanded).toBe(false);
  });

  it("streams commentary independently from the final assistant content", () => {
    const store = useChatStore.getState();
    store.appendLastAssistantCommentaryDelta("commentary-1", "先检查", 1);
    store.appendLastAssistantCommentaryDelta("commentary-1", "项目配置", 2);
    store.appendLastAssistantCommentaryDelta("commentary-2", "再运行测试", 3);
    store.finishLastAssistantCommentary("commentary-1", "先检查项目配置。", 4);
    store.finishLastAssistantCommentary("commentary-2", "", 5);

    expect(useChatStore.getState().messages[0]).toMatchObject({
      content: "",
      commentary: [
        { id: "commentary-1", content: "先检查项目配置。", isStreaming: false },
        { id: "commentary-2", content: "再运行测试", isStreaming: false },
      ],
    });
  });

  it("marks unfinished commentary complete when the assistant process ends", () => {
    const store = useChatStore.getState();
    store.appendLastAssistantCommentaryDelta("commentary-1", "处理中", 1);
    store.updateLastAssistantProcessMeta({
      planSteps: [
        { id: "pending", title: "等待", status: "pending" },
        { id: "running", title: "执行", status: "running" },
      ],
    });
    store.finishLastAssistantProcess(2);

    expect(useChatStore.getState().messages[0].commentary?.[0].isStreaming).toBe(false);
    expect(useChatStore.getState().messages[0].process?.planSteps?.map((step) => step.status))
      .toEqual(["completed", "completed"]);
  });

  it("backfills readable subagent identity and finalizes active lifecycle state", () => {
    const store = useChatStore.getState();
    store.appendLastAssistantProcessEntry({
      id: "spawn",
      type: "subagent",
      title: "已开始工作",
      timestamp: 1,
      state: "completed",
      subagents: [{ id: "thread-1", label: "Agent thread-1", status: "running" }],
    });
    store.appendLastAssistantProcessEntry({
      id: "activity",
      type: "subagent",
      title: "已更新",
      timestamp: 2,
      state: "running",
      subagents: [{
        id: "thread-1",
        label: "backend commentary",
        path: "/root/backend_commentary",
        status: "running",
      }],
    });

    let entries = useChatStore.getState().messages[0].process?.entries || [];
    expect(entries[0].subagents?.[0]).toEqual(expect.objectContaining({
      label: "backend commentary",
      path: "/root/backend_commentary",
    }));

    useChatStore.getState().finishLastAssistantProcess(3, "completed");
    entries = useChatStore.getState().messages[0].process?.entries || [];
    expect(entries.flatMap((entry) => entry.subagents || []).map((subagent) => subagent.status))
      .toEqual(["completed", "completed"]);
  });

  it("merges partial subagent updates that share one lifecycle id", () => {
    const store = useChatStore.getState();
    store.appendLastAssistantProcessEntry({
      id: "spawn-group",
      type: "subagent",
      title: "已开始工作",
      timestamp: 1,
      state: "running",
      subagents: [
        { id: "thread-1", label: "Backend", status: "running" },
        { id: "thread-2", label: "Frontend", status: "running" },
      ],
    });
    store.updateLastAssistantProcessEntry("spawn-group", {
      state: "completed",
      subagents: [{ id: "thread-1", label: "Backend", status: "completed" }],
    });

    expect(useChatStore.getState().messages[0].process?.entries[0]).toEqual(expect.objectContaining({
      timestamp: 1,
      state: "completed",
      subagents: [
        expect.objectContaining({ id: "thread-1", status: "completed" }),
        expect.objectContaining({ id: "thread-2", status: "running" }),
      ],
    }));
  });

  it("finishes the process containing a questionnaire without ending a newer process", () => {
    useChatStore.setState({ activeSessionId: "session-1" });
    const store = useChatStore.getState();
    store.startAssistantProcess(1, "session-1");
    store.appendLastAssistantProcessEntry({
      id: "analyze",
      type: "status",
      title: "正在分析请求并生成响应",
      timestamp: 1,
      state: "running",
    }, "session-1");
    store.appendLastAssistantProcessEntry({
      id: "question",
      type: "question",
      title: "正在询问用户",
      timestamp: 1,
      state: "running",
    }, "session-1");
    store.addMessage({ id: "answer", role: "user", content: "选项 A", timestamp: 2 }, "session-1");
    store.startAssistantProcess(3, "session-1");
    store.appendLastAssistantProcessEntry({
      id: "continued",
      type: "status",
      title: "继续处理回答",
      timestamp: 3,
      state: "running",
    }, "session-1");

    const latestStore = useChatStore.getState();
    latestStore.updateLastAssistantProcessEntry("question", { state: "completed" }, "session-1");
    latestStore.finishAssistantProcessContainingEntry("question", 4, "completed", "session-1");

    const assistants = useChatStore.getState().messages.filter((message) => message.role === "assistant");
    expect(assistants[0].process?.endedAt).toBe(4);
    expect(assistants[0].process?.entries.map((entry) => entry.state)).toEqual(["completed", "completed"]);
    expect(assistants[1].isStreaming).toBe(true);
    expect(assistants[1].process?.entries[0].state).toBe("running");
  });

  it("settles an unfinished orphan at its own last activity when a later turn starts", () => {
    useChatStore.setState({ activeSessionId: "session-superseded" });
    const store = useChatStore.getState();
    store.startAssistantProcess(1, "session-superseded");
    store.appendLastAssistantProcessEntry({
      id: "old-thinking",
      type: "thinking",
      title: "正在思考",
      timestamp: 1,
      state: "running",
    }, "session-superseded");
    store.addMessage({ id: "next-user", role: "user", content: "继续", timestamp: 2_000_000 }, "session-superseded");
    store.startAssistantProcess(3_000_000, "session-superseded");

    const assistants = useChatStore.getState().messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({
      isStreaming: false,
      process: { endedAt: 1, expanded: false, entries: [{ state: "completed" }] },
    });
    expect(assistants[1]).toMatchObject({
      isStreaming: true,
      process: { startedAt: 3_000_000 },
    });
  });

  it("settles every open process and repairs nested running state under an existing end time", () => {
    const messages = [{
      id: "open",
      role: "assistant" as const,
      content: "",
      timestamp: 1,
      isStreaming: true,
      commentary: [{ id: "note", content: "处理中", timestamp: 2, isStreaming: true }],
      process: {
        startedAt: 1,
        entries: [{
          id: "tool",
          type: "tool" as const,
          title: "正在写入",
          timestamp: 2,
          state: "running" as const,
          subagents: [{ id: "child", label: "Child", status: "pending" as const }],
        }],
        planSteps: [{ id: "step", title: "写入", status: "running" as const }],
      },
    }, {
      id: "inconsistent-ended",
      role: "assistant" as const,
      content: "已完成",
      timestamp: 10,
      process: {
        startedAt: 10,
        endedAt: 20,
        entries: [{
          id: "subagent",
          type: "subagent" as const,
          title: "子代理",
          timestamp: 11,
          state: "completed" as const,
          subagents: [{ id: "child-2", label: "Child 2", status: "running" as const }],
        }],
        planSteps: [{ id: "step-2", title: "收尾", status: "pending" as const }],
      },
    }];
    useChatStore.setState({
      activeSessionId: "session-all",
      messages,
      sessionMessages: { "session-all": messages },
    });

    useChatStore.getState().finishAllAssistantProcesses(50, "interrupted", "session-all");

    const settled = useChatStore.getState().messages;
    expect(settled[0]).toMatchObject({
      isStreaming: false,
      commentary: [{ isStreaming: false }],
      process: {
        endedAt: 2,
        entries: [{ state: "interrupted", subagents: [{ status: "interrupted" }] }],
        planSteps: [{ status: "cancelled" }],
      },
    });
    expect(settled[1]).toMatchObject({
      process: {
        endedAt: 20,
        entries: [{ state: "completed", subagents: [{ status: "interrupted" }] }],
        planSteps: [{ status: "cancelled" }],
      },
    });
    expect(useChatStore.getState().sessionMessages["session-all"]).toEqual(settled);
  });

  it("uses local activity times for old orphans and the terminal time only for the current turn", () => {
    const messages = [{
      id: "old-orphan-one",
      role: "assistant" as const,
      content: "",
      timestamp: 100,
      process: {
        startedAt: 100,
        entries: [{
          id: "old-tool-one",
          type: "tool" as const,
          title: "old one",
          timestamp: 120,
          state: "running" as const,
        }],
      },
    }, {
      id: "old-orphan-two",
      role: "assistant" as const,
      content: "",
      timestamp: 200,
      process: {
        // The process start itself is its newest valid activity and must be
        // retained even if an entry carried an earlier timestamp.
        startedAt: 250,
        entries: [{
          id: "old-tool-two",
          type: "tool" as const,
          title: "old two",
          timestamp: 240,
          state: "running" as const,
        }],
      },
    }, {
      id: "latest-user",
      role: "user" as const,
      content: "current request",
      timestamp: 300,
    }, {
      id: "current-turn",
      role: "assistant" as const,
      content: "",
      timestamp: 310,
      process: {
        startedAt: 310,
        entries: [{
          id: "current-tool",
          type: "tool" as const,
          title: "current",
          timestamp: 330,
          state: "running" as const,
        }],
      },
    }];
    useChatStore.setState({
      activeSessionId: "mixed-orphans",
      messages,
      sessionMessages: { "mixed-orphans": messages },
    });

    useChatStore.getState().finishAllAssistantProcesses(1_000, "completed", "mixed-orphans");

    const assistantEndTimes = useChatStore.getState().messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.process?.endedAt);
    expect(assistantEndTimes).toEqual([120, 250, 1_000]);
  });

  it("never records a process end before its start", () => {
    const messages = [{
      id: "invalid-terminal-order",
      role: "assistant" as const,
      content: "",
      timestamp: 100,
      isStreaming: true,
      process: {
        startedAt: 500,
        endedAt: 400,
        entries: [],
      },
    }];
    useChatStore.setState({
      activeSessionId: "invalid-terminal-order",
      messages,
      sessionMessages: { "invalid-terminal-order": messages },
    });

    useChatStore.getState().finishAllAssistantProcesses(450, "interrupted", "invalid-terminal-order");

    expect(useChatStore.getState().messages[0].process?.endedAt).toBe(500);
  });

  it("recognizes and settles a phase-only started process entry", () => {
    const messages = [{
      id: "phase-only",
      role: "assistant" as const,
      content: "",
      timestamp: 1,
      isStreaming: false,
      process: {
        startedAt: 1,
        entries: [{
          id: "phase-only-tool",
          type: "tool" as const,
          title: "started without state",
          timestamp: 2,
          phase: "started" as const,
        }],
      },
    }];
    useChatStore.setState({
      activeSessionId: "phase-only-session",
      messages,
      sessionMessages: { "phase-only-session": messages },
    });

    useChatStore.getState().finishAllAssistantProcesses(3, "interrupted", "phase-only-session");

    expect(useChatStore.getState().messages[0].process).toMatchObject({
      endedAt: 3,
      entries: [{
        state: "interrupted",
        phase: "completed",
        completedAt: 3,
      }],
    });
  });

  it("settles an inactive session without replacing the active message list", () => {
    const activeMessages = [{ id: "active", role: "user" as const, content: "active", timestamp: 1 }];
    useChatStore.setState({
      activeSessionId: "active-session",
      messages: activeMessages,
      sessionMessages: {
        "active-session": activeMessages,
        "background-session": [{
          id: "background",
          role: "assistant",
          content: "",
          timestamp: 2,
          isStreaming: true,
          process: {
            startedAt: 2,
            entries: [{
              id: "thinking",
              type: "thinking",
              title: "正在思考",
              timestamp: 2,
              state: "running",
            }],
          },
        }],
      },
    });

    useChatStore.getState().finishAllAssistantProcesses(3, "completed", "background-session");

    expect(useChatStore.getState().messages).toBe(activeMessages);
    expect(useChatStore.getState().sessionMessages["background-session"][0]).toMatchObject({
      isStreaming: false,
      process: { endedAt: 3, entries: [{ state: "completed" }] },
    });
  });

  it("updates one context compaction divider from running to completed", () => {
    useChatStore.setState({ activeSessionId: "session-1" });
    const store = useChatStore.getState();
    store.setSessionCompacting("session-1", true);
    store.appendContextCompactionDivider("compact-1", "session-1", "running");

    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        eventId: "compact-1",
        content: "上下文压缩中",
        compactionState: "running",
      }),
    ]);
    expect(useChatStore.getState().compactingSessions["session-1"]).toBe(true);

    store.setSessionCompacting("session-1", false);
    store.appendContextCompactionDivider("compact-1", "session-1", "completed");

    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        eventId: "compact-1",
        content: "上下文已自动压缩",
        compactionState: "completed",
      }),
    ]);
    expect(useChatStore.getState().compactingSessions["session-1"]).toBeUndefined();
  });

  it("atomically interrupts only running compaction dividers for one session", () => {
    useChatStore.getState().switchSession("session-compaction-interrupt");
    const store = useChatStore.getState();
    store.setSessionCompacting("session-compaction-interrupt", true);
    store.appendContextCompactionDivider("running-1", "session-compaction-interrupt", "running");
    store.appendContextCompactionDivider("completed", "session-compaction-interrupt", "completed");
    store.appendContextCompactionDivider("running-2", "session-compaction-interrupt", "running");

    store.interruptSessionCompaction("session-compaction-interrupt");

    const dividers = useChatStore.getState().messages;
    expect(dividers.map((message) => message.compactionState))
      .toEqual(["interrupted", "completed", "interrupted"]);
    expect(dividers.map((message) => message.content)).toEqual([
      "上下文压缩已中断",
      "上下文已自动压缩",
      "上下文压缩已中断",
    ]);
    expect(useChatStore.getState().compactingSessions["session-compaction-interrupt"]).toBeUndefined();
    expect(useChatStore.getState().sessionMessages["session-compaction-interrupt"]).toEqual(dividers);
  });

  it("keeps a post-compaction assistant continuation before the divider", () => {
    useChatStore.getState().switchSession("session-compaction-order");
    useChatStore.getState().addMessage({
      id: "assistant-before",
      role: "assistant",
      content: "压缩前正文",
      timestamp: 1,
      isStreaming: false,
    }, "session-compaction-order");
    useChatStore.getState().appendContextCompactionDivider(
      "compaction-order",
      "session-compaction-order",
      "running",
    );

    useChatStore.getState().startAssistantProcess(2, "session-compaction-order");
    useChatStore.getState().updateLastAssistant("压缩后续写正文", "session-compaction-order");

    const messages = useChatStore.getState().sessionMessages["session-compaction-order"];
    expect(messages.map((message) => message.role)).toEqual(["assistant", "assistant", "system"]);
    expect(messages[1].content).toBe("压缩后续写正文");
    expect(messages[2]).toMatchObject({
      systemType: "context_compaction",
      compactionState: "running",
    });
  });
});

describe("session model isolation", () => {
  it("clears the previous session model and catalog on session switch", () => {
    const staleModel = {
      id: "old-model",
      name: "Old model",
      provider: "old-provider",
      reasoning: false,
    };
    useChatStore.setState({
      activeSessionId: "old-session",
      messages: [],
      sessionMessages: {},
      currentModel: staleModel,
      availableModels: [staleModel],
      thinkingLevel: "high",
    });

    useChatStore.getState().switchSession("new-session");

    expect(useChatStore.getState()).toMatchObject({
      activeSessionId: "new-session",
      currentModel: null,
      availableModels: [],
      thinkingLevel: "medium",
    });
  });
});

describe("session draft replacement", () => {
  it("atomically clones every composer field", () => {
    const draft = {
      text: "draft",
      pendingImages: [],
      pendingFiles: [{ id: "file", fileName: "a.ts", filePath: "C:\\a.ts", startLine: 1, endLine: 2 }],
      pendingPathAttachments: [{ id: "folder", name: "src", path: "C:\\src", kind: "folder" as const }],
      sessionReferences: [],
      action: { kind: "skill" as const, name: "review" },
    };
    useChatStore.getState().replaceSessionDraft("session", draft);
    draft.pendingFiles[0].fileName = "mutated.ts";
    draft.action.name = "mutated";
    expect(useChatStore.getState().sessionDrafts.session).toMatchObject({
      text: "draft",
      pendingFiles: [{ fileName: "a.ts" }],
      pendingPathAttachments: [{ kind: "folder" }],
      action: { kind: "skill", name: "review" },
    });
  });
});
