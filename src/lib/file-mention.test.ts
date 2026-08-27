import { describe, expect, it } from "vitest";
import { parseActiveFileMention, replaceFileMentionToken } from "./file-mention";

describe("parseActiveFileMention", () => {
  it("parses an empty query at the start of a line", () => {
    expect(parseActiveFileMention("@", 1)).toEqual({
      query: "",
      start: 0,
      end: 1,
    });
  });

  it("does not swallow pre-existing text after an empty query (CJK)", () => {
    // Caret right after "@" at the start of a sentence: selecting a file
    // must replace only the "@" and keep the rest of the line.
    const value = "@你好世界";
    expect(parseActiveFileMention(value, 1)).toEqual({
      query: "",
      start: 0,
      end: 1,
    });
  });

  it("does not swallow pre-existing text after an empty query (latin)", () => {
    const value = "@hello world";
    expect(parseActiveFileMention(value, 1)).toEqual({
      query: "",
      start: 0,
      end: 1,
    });
  });

  it("does not infer additional Latin query text after the caret", () => {
    const value = "@hello world";
    const caret = value.indexOf("o world");
    expect(parseActiveFileMention(value, caret)).toEqual({
      query: "hell",
      start: 0,
      end: caret,
    });
  });

  it("parses a query after Chinese text and a whitespace boundary", () => {
    const value = "请查看 @配置文件";
    expect(parseActiveFileMention(value, value.length)).toEqual({
      query: "配置文件",
      start: 4,
      end: value.length,
    });
  });

  it("supports a mention directly after Chinese text", () => {
    const value = "请查看@ChatPanel";
    expect(parseActiveFileMention(value, value.length)).toEqual({
      query: "ChatPanel",
      start: 3,
      end: value.length,
    });
  });

  it("does not treat an email address as a file mention", () => {
    const value = "联系 user@example.com";
    expect(parseActiveFileMention(value, value.length)).toBeNull();
  });

  it("does not parse a non-collapsed selection", () => {
    expect(parseActiveFileMention("@chat", 2, 5)).toBeNull();
  });

  it("uses only text before the caret as the query and replacement range", () => {
    const value = "open @ChatComposer.tsx next";
    const caret = value.indexOf("Composer");
    expect(parseActiveFileMention(value, caret)).toEqual({
      query: "Chat",
      start: 5,
      end: caret,
    });
  });

  it("does not swallow a CJK sentence after an ASCII search term", () => {
    // User typed "请看一下", moved the caret to the front, then typed "@Read"
    // to reference a file: the trailing sentence has no whitespace separator,
    // so the token must end at the caret instead of eating the whole line.
    const value = "@Read请看一下";
    const caret = "@Read".length;
    expect(parseActiveFileMention(value, caret)).toEqual({
      query: "Read",
      start: 0,
      end: caret,
    });
  });

  it("does not swallow a CJK sentence after a partial ASCII path term", () => {
    const value = "@src/main.ts 请先看这里";
    const caret = "@src/main.ts".length;
    expect(parseActiveFileMention(value, caret)).toEqual({
      query: "src/main.ts",
      start: 0,
      end: caret,
    });
  });

  it("does not swallow a CJK suffix after a CJK search term", () => {
    const value = "@配置请先看已有中文";
    const caret = "@配置".length;
    expect(parseActiveFileMention(value, caret)).toEqual({
      query: "配置",
      start: 0,
      end: caret,
    });
  });

  it("does not swallow a Latin suffix after a Latin search term", () => {
    const value = "@ReadkeepExistingLetters";
    const caret = "@Read".length;
    expect(parseActiveFileMention(value, caret)).toEqual({
      query: "Read",
      start: 0,
      end: caret,
    });
  });

  it("supports a mention at the start of a later line", () => {
    const value = "first line\n@src/file.ts";
    expect(parseActiveFileMention(value, value.length)).toEqual({
      query: "src/file.ts",
      start: value.indexOf("@"),
      end: value.length,
    });
  });
});

describe("replaceFileMentionToken", () => {
  it("removes the complete token while preserving surrounding text", () => {
    const value = "请查看 @ChatComposer.tsx 然后修改测试";
    const caret = value.indexOf(" 然后修改测试");
    const mention = parseActiveFileMention(value, caret);

    expect(mention).not.toBeNull();
    expect(replaceFileMentionToken(value, mention!)).toEqual({
      value: "请查看 然后修改测试",
      caret: 4,
    });
  });

  it("removes the following separator when the token starts the input", () => {
    const value = "@ChatComposer.tsx 后续正文";
    const mention = parseActiveFileMention(value, value.indexOf(" 后续"));

    expect(replaceFileMentionToken(value, mention!)).toEqual({
      value: "后续正文",
      caret: 0,
    });
  });

  it("preserves existing CJK text after a CJK mention query", () => {
    const value = "开头 @配置已有中文";
    const caret = value.indexOf("已有中文");
    const mention = parseActiveFileMention(value, caret);

    expect(mention).not.toBeNull();
    expect(replaceFileMentionToken(value, mention!, "配置文件.md")).toEqual({
      value: "开头 配置文件.md已有中文",
      caret: "开头 配置文件.md".length,
    });
  });

  it("preserves existing Latin text after a Latin mention query", () => {
    const value = "before @ReadkeepExistingLetters";
    const caret = value.indexOf("keepExistingLetters");
    const mention = parseActiveFileMention(value, caret);

    expect(mention).not.toBeNull();
    expect(replaceFileMentionToken(value, mention!, "README.md")).toEqual({
      value: "before README.mdkeepExistingLetters",
      caret: "before README.md".length,
    });
  });

  it("can replace the token with caller-provided text", () => {
    const value = "before @cha after";
    const mention = parseActiveFileMention(value, value.indexOf(" after"));

    expect(mention).not.toBeNull();
    expect(replaceFileMentionToken(value, mention!, "file.ts")).toEqual({
      value: "before file.ts after",
      caret: 14,
    });
  });
});
