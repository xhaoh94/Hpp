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
