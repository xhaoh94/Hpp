import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageArtifacts } from "./MessageArtifacts";
import { collectMessageArtifacts } from "@/lib/message-artifacts";
import type { ChatMessage } from "@/stores/chat-store";

// 与真实会话库里记下的结构一致（来自 session-messages.sqlite 的一条 assistant 消息）。
const realMessage = {
  id: "m-real",
  role: "assistant",
  content: "演示页已创建",
  timestamp: 1,
  process: {
    startedAt: 1,
    endedAt: 2,
    entries: [
      { id: "t1", type: "thinking", title: "思考", detail: "准备写演示页" },
      {
        id: "w1",
        type: "tool",
        toolKind: "write_file",
        title: "已写入 1 个文件",
        files: [{ file: "tmp/artifact-demo.html", action: "written" }],
        state: "completed",
        timestamp: 2,
      },
    ],
  },
} as unknown as ChatMessage;

describe("产物清单渲染探针", () => {
  it("能从真实的 write_file 记录里收集到产物", () => {
    expect(collectMessageArtifacts(realMessage).map((a) => a.name)).toEqual(["artifact-demo.html"]);
  });

  it("能渲染出「产物 1」", () => {
    const html = renderToStaticMarkup(createElement(MessageArtifacts, {
      message: realMessage,
      onOpenFile: () => {},
    }));
    // 收起态只显示计数；文件名在展开后才有。
    expect(html).toContain("产物 1");
    expect(html).toContain("chat-artifacts");
  });
});
