import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerMessageFlow } from "./ComposerMessageFlow";
import { createComposerDocument } from "@shared/composer-document";

describe("ComposerMessageFlow pasted blocks", () => {
  it("renders a compact label instead of dumping the pasted text into the DOM", () => {
    const pasted = Array.from({ length: 120 }, (_, index) => `log line ${index + 1}`).join("\n");
    const html = renderToStaticMarkup(createElement(ComposerMessageFlow, {
      document: createComposerDocument([
        { id: "t1", type: "text", text: "看下这段" },
        { id: "p1", type: "paste", text: pasted },
      ]),
    }));

    expect(html).toContain("粘贴文本 · 120 行");
    expect(html).toContain("看下这段");
    expect(html).not.toContain("log line 7");
  });
});
