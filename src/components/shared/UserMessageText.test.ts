import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserMessageText } from "./UserMessageText";

describe("UserMessageText", () => {
  it("renders a bare snippet as a code block with a guessed language", () => {
    const html = renderToStaticMarkup(createElement(UserMessageText, {
      text: "const a = 1;\nconst b = 2;",
    }));

    expect(html).toContain("md-code-block");
    expect(html).toContain("javascript");
    expect(html).toContain("chat-user-code-flow");
  });

  it("keeps prose as plain text with the caller's class", () => {
    const html = renderToStaticMarkup(createElement(UserMessageText, {
      text: "帮我看下这个导入顺序的问题",
      textClassName: "chat-user-content",
    }));

    expect(html).toContain("chat-user-content");
    expect(html).not.toContain("md-code-block");
  });

  it("renders fenced segments inline with the surrounding text", () => {
    const html = renderToStaticMarkup(createElement(UserMessageText, {
      text: "看这段：\n```ts\nconst a = 1;\n```\n有什么问题",
      textClassName: "composer-message-text",
    }));

    expect(html).toContain("md-code-block");
    expect(html).toContain("看这段：");
    expect(html).toContain("有什么问题");
    expect(html).toContain("language-ts");
  });

  it("skips auto-detection when the caller turns it off", () => {
    const html = renderToStaticMarkup(createElement(UserMessageText, {
      text: "const a = 1;\nconst b = 2;",
      autoDetect: false,
    }));

    expect(html).not.toContain("md-code-block");
  });
});
