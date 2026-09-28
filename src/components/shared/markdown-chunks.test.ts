import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { splitMarkdownChunks } from "./markdown-chunks";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

const stripPositions = (value: unknown): unknown => JSON.parse(
  JSON.stringify(value, (key, inner) => (key === "position" ? undefined : inner)),
);

const isWhitespaceText = (node: unknown): boolean => (
  typeof node === "object" && node !== null
  && (node as { type?: unknown }).type === "text"
  && String((node as { value?: unknown }).value ?? "").trim() === ""
);

const parseChildren = (markdown: string): unknown[] => {
  const tree = processor.runSync(processor.parse(markdown)) as { children: unknown[] };
  const children = stripPositions(tree.children) as unknown[];
  // 分块渲染时块首/块尾的空行会在根级留下纯空白文本节点，它们在浏览器里
  // 不产生任何可见内容，按空白归一化后再比较。
  return children.filter((node) => !isWhitespaceText(node));
};

/**
 * 分块必须同时满足两点：内容无损，且「逐块渲染」与「整篇渲染」得到相同的
 * hast 树。后者是本文件里所有切分规则的最终判据。
 */
const expectEquivalent = (content: string) => {
  const chunks = splitMarkdownChunks(content);
  expect(chunks.join("\n")).toBe(content);
  expect(chunks.flatMap((chunk) => parseChildren(chunk))).toEqual(parseChildren(content));
  return chunks;
};

describe("splitMarkdownChunks 基本行为", () => {
  it("空内容返回空数组", () => {
    expect(splitMarkdownChunks("")).toEqual([]);
  });

  it("在两个普通段落之间切开", () => {
    const chunks = expectEquivalent("第一段内容。\n\n第二段内容。");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("第一段内容。");
    expect(chunks[1]).toContain("第二段内容。");
  });

  it("围栏代码块整体留在同一个块里（含块内空行）", () => {
    const content = [
      "说明文字。",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "结尾段落。",
    ].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain("说明文字。");
    expect(chunks[1]).toContain("```ts");
    expect(chunks[1]).toContain("const b = 2;");
    expect(chunks[2]).toContain("结尾段落。");
  });

  it("列表即使内部有空行也不切开", () => {
    const content = ["- 第一项", "- 第二项", "", "- 第三项（松散列表）", "", "结尾段落。"].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(1);
  });

  it("表格不切开", () => {
    const content = ["| 列 A | 列 B |", "| --- | --- |", "| 1 | 2 |", "", "结尾段落。"].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(1);
  });

  it("引用块不切开", () => {
    const content = ["> 引用第一行", "", "> 引用第二行", "", "结尾段落。"].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(1);
  });

  it("setext 标题的下划线不会被拆到别的块里", () => {
    const content = ["标题", "===", "", "正文段落。"].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(1);
  });

  it("出现链接定义时放弃切分", () => {
    const content = [
      "第一段。",
      "",
      "第二段。",
      "",
      "[ref]: https://example.com",
    ].join("\n");
    expect(splitMarkdownChunks(content)).toEqual([content]);
  });

  it("出现脚注定义时放弃切分", () => {
    const content = ["正文里用了脚注[^1]。", "", "[^1]: 脚注内容。", "", "结尾段落。"].join("\n");
    expect(splitMarkdownChunks(content)).toEqual([content]);
  });

  it("未闭合的围栏保持打开状态（流式尾部）", () => {
    const content = ["说明。", "", "```ts", "const a = 1;", "", "// 还在流式输出"].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].trimStart().startsWith("```ts")).toBe(true);
  });

  it("缩进代码块不切开", () => {
    const content = ["段落。", "", "    缩进代码第一行", "", "    缩进代码第二行", "", "结尾。"].join("\n");
    const chunks = expectEquivalent(content);
    expect(chunks).toHaveLength(1);
  });
});

describe("splitMarkdownChunks 与整篇解析等价", () => {
  const samples: Array<[string, string]> = [
    ["多段落与标题", [
      "# 标题",
      "",
      "开场说明。",
      "",
      "## 小节",
      "",
      "小节内容一。",
      "",
      "小节内容二。",
    ].join("\n")],
    ["段落/代码/段落混合", [
      "先说明思路。",
      "",
      "```javascript",
      "function compute(input, offset) {",
      "  return input + offset;",
      "}",
      "```",
      "",
      "再解释代码。",
      "",
      "```python",
      "def transform(data, factor):",
      "    return data * factor",
      "```",
      "",
      "结尾总结。",
    ].join("\n")],
    ["列表与后续段落", [
      "要点如下：",
      "",
      "1. 第一点",
      "2. 第二点",
      "",
      "下面是补充说明段落。",
      "",
      "另一段说明。",
    ].join("\n")],
    ["嵌套列表与任务列表", [
      "任务清单：",
      "",
      "- [x] 已完成项",
      "- [ ] 待办项",
      "  - 子项一",
      "  - 子项二",
      "",
      "收尾段落。",
    ].join("\n")],
    ["引用与表格", [
      "> 引用内容第一段",
      "",
      "> 引用内容第二段",
      "",
      "| 列 A | 列 B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "| 3 | 4 |",
      "",
      "结束。",
    ].join("\n")],
    ["行内格式与链接", [
      "包含 **加粗**、*斜体*、`inline code` 与 [链接](https://example.com) 的段落。",
      "",
      "包含 Windows 路径 `E:\\project\\file.lua` 的段落。",
      "",
      "结束段落。",
    ].join("\n")],
    ["水平线与 HTML 块", [
      "第一段。",
      "",
      "---",
      "",
      "第二段。",
      "",
      "<div>",
      "",
      "块内文字",
      "",
      "</div>",
      "",
      "第三段。",
    ].join("\n")],
    ["代码块内含未闭合围栏前缀", [
      "解释。",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "继续说明。",
      "",
      "```ts",
      "const y = 2;",
    ].join("\n")],
  ];

  for (const [name, content] of samples) {
    it(name, () => {
      expectEquivalent(content);
    });
  }
});
