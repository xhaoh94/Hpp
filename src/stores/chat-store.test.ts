import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "./chat-store";

describe("chat process entry defaults", () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      sessionMessages: {},
      activeSessionId: null,
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
    store.finishLastAssistantProcess(2);

    expect(useChatStore.getState().messages[0].commentary?.[0].isStreaming).toBe(false);
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
