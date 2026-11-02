import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./notification-text";

describe("markdownToPlainText", () => {
  it("strips the markers that leaked into Windows notifications", () => {
    const text = markdownToPlainText([
      "## 这 1 秒的构成（本机实测）",
      "`agent:createSession` 在 `agent-manager.ts:1434` 打点，它做三件事：",
      "- `createSession()` → 拿到 backend",
      "- `getModelsBySessionId()`",
    ].join("\n"));

    expect(text).not.toContain("#");
    expect(text).not.toContain("`");
    expect(text).toContain("这 1 秒的构成（本机实测）");
    expect(text).toContain("agent:createSession 在 agent-manager.ts:1434 打点");
    expect(text).toContain("createSession() → 拿到 backend");
  });

  it("keeps link text, image alt text and code block bodies", () => {
    const text = markdownToPlainText([
      "见 [文档](https://example.com/doc) 和 ![截图](https://example.com/a.png)",
      "```bash",
      "npm run build",
      "```",
    ].join("\n"));

    expect(text).toContain("文档");
    expect(text).not.toContain("https://example.com/doc");
    expect(text).toContain("截图");
    expect(text).not.toContain("```");
    expect(text).toContain("npm run build");
  });

  it("drops emphasis, blockquote, table and rule markers", () => {
    const text = markdownToPlainText([
      "> 引用内容",
      "",
      "| 阶段 | 耗时 |",
      "| --- | --- |",
      "| spawn | 8ms |",
      "",
      "**加粗** 与 ~~删除~~",
      "---",
    ].join("\n"));

    expect(text).toContain("引用内容");
    expect(text).toContain("加粗");
    expect(text).toContain("删除");
    expect(text).toContain("spawn");
    expect(text).not.toContain("**");
    expect(text).not.toContain("~~");
    expect(text).not.toContain("|");
    expect(text).not.toContain(">");
  });

  it("leaves snake_case identifiers alone", () => {
    expect(markdownToPlainText("use_chat_store 和 a_b_c")).toBe("use_chat_store 和 a_b_c");
  });
});
