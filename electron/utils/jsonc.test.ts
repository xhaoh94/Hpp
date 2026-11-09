import { describe, expect, it } from "vitest";

import { parseJsonc, parseJsoncFileContent } from "./jsonc";

describe("JSONC 解析", () => {
  it("解析普通 JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  it("吃掉行注释和块注释", () => {
    const text = `[
      // 一条注释
      { "label": "a" }, /* 行内 */
      { "label": "b" }
    ]`;
    expect(parseJsonc(text)).toEqual([{ label: "a" }, { label: "b" }]);
  });

  it("吃掉尾逗号", () => {
    expect(parseJsonc('[1, 2, ]')).toEqual([1, 2]);
    expect(parseJsonc('{"a": 1,}')).toEqual({ a: 1 });
  });

  it("吃掉数组末尾的尾逗号（pi settings.json 的真实形态）", () => {
    const text = `{
  "packages": [
    "npm:pi-web-access",
  ],
}`;
    expect(parseJsonc(text)).toEqual({ packages: ["npm:pi-web-access"] });
  });

  it("字符串里的 // 和 ,} 原样保留", () => {
    const text = '[{ "command": "echo http://x ,}" }]';
    expect(parseJsonc(text)).toEqual([{ command: "echo http://x ,}" }]);
  });

  it("字符串里的转义引号不会提前结束字符串", () => {
    const text = '[{ "command": "say \\"hi // not a comment\\"" }]';
    expect(parseJsonc(text)).toEqual([{ command: 'say "hi // not a comment"' }]);
  });

  it("带 BOM 的文件内容也能解析，错误信息里带路径", () => {
    expect(parseJsoncFileContent('\uFEFF{"a":1}', "x.json")).toEqual({ a: 1 });
    let message = "";
    try {
      parseJsoncFileContent("{", "C:/tmp/broken.json");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("C:/tmp/broken.json");
  });
});
