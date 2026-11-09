import { describe, expect, it } from "vitest";
import {
  createComposerDocument,
  getComposerFullText,
  getComposerNodeLabel,
  getComposerPasteStats,
  getComposerPlainText,
  MAX_COMPOSER_PASTE_CHARS,
  parseComposerDocument,
  truncateComposerDocumentLines,
} from "./composer-document";

const textNode = (id: string, text: string) => ({ id, type: "text" as const, text });
const pathNode = (id: string, name: string) => ({
  id,
  type: "path" as const,
  name,
  path: `/tmp/${name}`,
  kind: "file" as const,
});

describe("video attachments in composer documents", () => {
  it("keeps video nodes through serialization and labels them for plain text", () => {
    const parsed = parseComposerDocument({
      version: 1,
      nodes: [{
        id: "video-1",
        type: "video",
        name: "clip.mp4",
        path: "C:/repo/clip.mp4",
        mimeType: "video/mp4",
      }],
    });
    expect(parsed?.nodes).toEqual([{
      id: "video-1",
      type: "video",
      name: "clip.mp4",
      path: "C:/repo/clip.mp4",
      mimeType: "video/mp4",
    }]);
    expect(getComposerNodeLabel(parsed!.nodes[0] as never)).toBe("[video: clip.mp4]");
  });

  it("rejects video nodes without a path instead of inventing one", () => {
    const parsed = parseComposerDocument({
      version: 1,
      nodes: [{ id: "video-bad", type: "video", name: "clip.mp4", mimeType: "video/mp4" }],
    });
    // 无法预览/发送的节点退回为文本占位，不会生成指向空路径的卡片。
    expect(parsed?.nodes[0]).toMatchObject({ type: "text" });
  });
});

describe("truncateComposerDocumentLines", () => {  it("keeps only the leading lines of a single text node", () => {
    const document = createComposerDocument([textNode("t1", "l1\nl2\nl3\nl4")]);

    expect(getComposerPlainText(truncateComposerDocumentLines(document, 2))).toBe("l1\nl2");
  });

  it("matches the plain-text folding used before composer documents existed", () => {
    const raw = Array.from({ length: 14 }, (_, index) => `第 ${index + 1} 行`).join("\n");
    const document = createComposerDocument([textNode("t1", raw)]);

    expect(getComposerPlainText(truncateComposerDocumentLines(document, 10)))
      .toBe(raw.split("\n").slice(0, 10).join("\n"));
  });

  it("keeps chips resting on the last kept line and drops everything after it", () => {
    const document = createComposerDocument([
      textNode("t1", "l1\nl2\nl3"),
      pathNode("p1", "keep.ts"),
      textNode("t2", "\nl4"),
      pathNode("p2", "drop.ts"),
    ]);

    const truncated = truncateComposerDocumentLines(document, 3);

    expect(truncated.nodes.map((node) => node.id)).toEqual(["t1", "p1"]);
    expect(getComposerPlainText(truncated)).toBe("l1\nl2\nl3");
  });

  it("counts newlines across separate text nodes", () => {
    const document = createComposerDocument([
      textNode("t1", "l1\n"),
      pathNode("p1", "keep.ts"),
      textNode("t2", "l2\nl3\nl4"),
    ]);

    const truncated = truncateComposerDocumentLines(document, 2);

    expect(truncated.nodes.map((node) => node.id)).toEqual(["t1", "p1", "t2"]);
    expect(getComposerPlainText(truncated)).toBe("l1\nl2");
  });

  it("returns an empty document for a non-positive limit and leaves the source untouched", () => {
    const document = createComposerDocument([textNode("t1", "l1\nl2")]);

    expect(truncateComposerDocumentLines(document, 0).nodes).toEqual([]);
    expect(getComposerPlainText(truncateComposerDocumentLines(document, 1))).toBe("l1");
    expect(getComposerPlainText(document)).toBe("l1\nl2");
  });
});

describe("pasted text nodes", () => {
  const pasteNode = (id: string, text: string) => ({ id, type: "paste" as const, text });

  it("round-trips a pasted block without merging it into neighbouring text", () => {
    const parsed = parseComposerDocument({
      version: 1,
      nodes: [
        { id: "t1", type: "text", text: "看下这段日志" },
        { id: "p1", type: "paste", text: "line1\nline2" },
        { id: "t2", type: "text", text: "什么原因" },
      ],
    });

    expect(parsed?.nodes.map((node) => node.type)).toEqual(["text", "paste", "text"]);
    // 粘贴块自己的原文不能被拼进相邻的纯文本节点。
    expect(getComposerPlainText(parsed!)).toBe("看下这段日志什么原因");
    expect(getComposerFullText(parsed!)).toBe("看下这段日志line1\nline2什么原因");
  });

  it("keeps the full original text out of plain text but in the full text", () => {
    const document = createComposerDocument([pasteNode("p1", "a\nb\nc")]);

    expect(getComposerPlainText(document)).toBe("");
    expect(getComposerFullText(document)).toBe("a\nb\nc");
    expect(getComposerPasteStats("a\nb\nc")).toEqual({ chars: 5, lines: 3, bytes: 5 });
  });

  it("keeps a paste on the last visible line instead of counting its own lines", () => {
    const document = createComposerDocument([
      textNode("t1", "l1\nl2"),
      pasteNode("p1", "pasted\nblock\nlines"),
    ]);

    const truncated = truncateComposerDocumentLines(document, 2);

    // 标签本身不换行：粘贴块里有多少行都不影响截断结果。
    expect(truncated.nodes.map((node) => node.id)).toEqual(["t1", "p1"]);
    expect(getComposerPlainText(truncated)).toBe("l1\nl2");
  });

  it("drops pastes that fall after the collapsed lines, like other chips", () => {
    const document = createComposerDocument([
      textNode("t1", "l1\nl2\nl3"),
      pasteNode("p1", "pasted"),
    ]);

    expect(truncateComposerDocumentLines(document, 2).nodes.map((node) => node.id)).toEqual(["t1"]);
  });

  it("degrades unusable pastes to text labels instead of dropping them silently", () => {
    const empty = parseComposerDocument({ version: 1, nodes: [{ id: "p0", type: "paste", text: "" }] });
    const oversized = parseComposerDocument({
      version: 1,
      nodes: [{ id: "p1", type: "paste", text: "x".repeat(MAX_COMPOSER_PASTE_CHARS + 1) }],
    });

    expect(empty?.nodes[0]).toMatchObject({ type: "text" });
    expect(oversized?.nodes[0]).toMatchObject({ type: "text" });
  });

  it("labels pasted blocks by line count", () => {
    expect(getComposerNodeLabel(pasteNode("p1", "a\nb\nc") as never)).toBe("[粘贴文本: 3 行]");
  });
});
