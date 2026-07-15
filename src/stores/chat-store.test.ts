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
});
