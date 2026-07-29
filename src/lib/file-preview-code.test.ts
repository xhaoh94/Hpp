import { describe, expect, it } from "vitest";
import {
  buildDisplayTokens,
  buildHighlightedLines,
  findTextMatches,
  getFilePreviewLanguage,
  getNextSearchMatchIndex,
  getRenderWindow,
  parseGoToLine,
} from "./file-preview-code";

describe("file preview code utilities", () => {
  it("maps supported extensions and leaves unknown files as plain text", () => {
    expect(getFilePreviewLanguage("C:\\project\\example.tsx")).toBe("typescript");
    expect(getFilePreviewLanguage("/tmp/script.ps1")).toBe("powershell");
    expect(getFilePreviewLanguage("/tmp/plugin.lua")).toBe("lua");
    expect(getFilePreviewLanguage("settings.toml")).toBe("ini");
    expect(getFilePreviewLanguage("notes.txt")).toBeNull();
  });

  it("finds case-insensitive, non-overlapping text matches", () => {
    expect(findTextMatches(["Hello hello", "中文中文"], "hello")).toEqual([
      { lineNumber: 1, startColumn: 0, endColumn: 5 },
      { lineNumber: 1, startColumn: 6, endColumn: 11 },
    ]);
    expect(findTextMatches(["中文中文"], "中文")).toEqual([
      { lineNumber: 1, startColumn: 0, endColumn: 2 },
      { lineNumber: 1, startColumn: 2, endColumn: 4 },
    ]);
  });

  it("supports case-sensitive and whole-word matching for Latin and Chinese text", () => {
    expect(findTextMatches(["GetText gettext GetTextValue"], "GetText", { matchCase: true }))
      .toEqual([
        { lineNumber: 1, startColumn: 0, endColumn: 7 },
        { lineNumber: 1, startColumn: 16, endColumn: 23 },
      ]);
    expect(findTextMatches(["GetText gettext GetTextValue"], "GetText", {
      matchCase: true,
      wholeWord: true,
    })).toEqual([{ lineNumber: 1, startColumn: 0, endColumn: 7 }]);
    expect(findTextMatches(["中文 中文测试 中文"], "中文", { wholeWord: true })).toEqual([
      { lineNumber: 1, startColumn: 0, endColumn: 2 },
      { lineNumber: 1, startColumn: 8, endColumn: 10 },
    ]);
    expect(findTextMatches(["foo_bar foo-bar"], "foo", { wholeWord: true })).toEqual([
      { lineNumber: 1, startColumn: 8, endColumn: 11 },
    ]);
  });

  it("centers a bounded render window around distant target lines", () => {
    expect(getRenderWindow(2500, 1, 1000)).toEqual({ startIndex: 0, endIndex: 1000 });
    expect(getRenderWindow(2500, 1201, 1000)).toEqual({ startIndex: 700, endIndex: 1700 });
    expect(getRenderWindow(2500, 2500, 1000)).toEqual({ startIndex: 1500, endIndex: 2500 });
  });

  it("wraps search navigation and validates go-to-line input", () => {
    expect(getNextSearchMatchIndex(2, 3, 1)).toBe(0);
    expect(getNextSearchMatchIndex(0, 3, -1)).toBe(2);
    expect(getNextSearchMatchIndex(-1, 3, 1)).toBe(0);
    expect(getNextSearchMatchIndex(-1, 0, 1)).toBe(-1);
    expect(parseGoToLine(" 1201 ", 2500)).toBe(1201);
    expect(parseGoToLine("0", 2500)).toBeNull();
    expect(parseGoToLine("2501", 2500)).toBeNull();
    expect(parseGoToLine("12.5", 2500)).toBeNull();
  });

  it("keeps multiline syntax context and separates search marks from syntax tokens", () => {
    const lines = buildHighlightedLines("/* first\nsecond */\nconst value = 1;", "typescript");
    expect(lines).toHaveLength(3);
    expect(lines[0].some((token) => token.classNames.includes("hljs-comment"))).toBe(true);
    expect(lines[1].some((token) => token.classNames.includes("hljs-comment"))).toBe(true);

    const display = buildDisplayTokens(lines[2], [{
      lineNumber: 3,
      startColumn: 6,
      endColumn: 11,
      matchIndex: 0,
    }]);
    expect(display.filter((token) => token.matchIndex === 0).map((token) => token.text).join(""))
      .toBe("value");
  });
});
