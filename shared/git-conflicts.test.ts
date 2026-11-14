import { describe, expect, it } from "vitest";

import { buildResolvedContent, parseConflictFile } from "./git-conflicts";

describe("parseConflictFile", () => {
  it("splits a merge-style conflict into text and one block", () => {
    const content = [
      "line before\n",
      "<<<<<<< HEAD\n",
      "ours line\n",
      "=======\n",
      "theirs line\n",
      ">>>>>>> feature\n",
      "line after\n",
    ].join("");

    const parsed = parseConflictFile(content);
    expect(parsed.malformed).toBe(false);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({
      ours: "ours line\n",
      base: null,
      theirs: "theirs line\n",
      labels: { ours: "HEAD", theirs: "feature" },
    });
    expect(parsed.segments.map((segment) => segment.kind)).toEqual(["text", "conflict", "text"]);
  });

  it("keeps the common ancestor section of a diff3 conflict", () => {
    const content = [
      "<<<<<<< ours\n",
      "a\n",
      "||||||| base\n",
      "b\n",
      "=======\n",
      "c\n",
      ">>>>>>> theirs\n",
    ].join("");

    const parsed = parseConflictFile(content);
    expect(parsed.blocks[0]).toMatchObject({ ours: "a\n", base: "b\n", theirs: "c\n", labels: { base: "base" } });
  });

  it("handles multiple blocks and preserves CRLF", () => {
    const content = "x\r\n<<<<<<< a\r\n1\r\n=======\r\n2\r\n>>>>>>> b\r\nmid\r\n<<<<<<< a\r\n3\r\n=======\r\n4\r\n>>>>>>> b\r\n";
    const parsed = parseConflictFile(content);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[1]?.theirs).toBe("4\r\n");
    expect(buildResolvedContent(parsed, ["1\r\n", "4\r\n"])).toBe("x\r\n1\r\nmid\r\n4\r\n");
  });

  it("treats unclosed markers as plain text instead of dropping content", () => {
    const content = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n";
    const parsed = parseConflictFile(content);
    expect(parsed.malformed).toBe(true);
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]).toEqual({ kind: "text", text: content });
  });

  it("leaves files without markers untouched", () => {
    const parsed = parseConflictFile("plain\nfile\n");
    expect(parsed.blocks).toHaveLength(0);
    expect(buildResolvedContent(parsed, [])).toBe("plain\nfile\n");
  });
});

describe("buildResolvedContent", () => {
  it("adds the missing trailing newline so blocks do not merge into the next line", () => {
    const parsed = parseConflictFile("<<<<<<< a\nours\n=======\ntheirs\n>>>>>>> b\nrest\n");
    expect(buildResolvedContent(parsed, ["ours"])).toBe("ours\nrest\n");
    expect(buildResolvedContent(parsed, ["ours\ntheirs\n"])).toBe("ours\ntheirs\nrest\n");
  });

  it("falls back to the current branch side when a resolution is missing", () => {
    const parsed = parseConflictFile("<<<<<<< a\nours\n=======\ntheirs\n>>>>>>> b\n");
    expect(buildResolvedContent(parsed, [])).toBe("ours\n");
  });
});
