import { describe, expect, it } from "vitest";
import {
  createComposerDocument,
  getComposerPlainText,
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

describe("truncateComposerDocumentLines", () => {
  it("keeps only the leading lines of a single text node", () => {
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
