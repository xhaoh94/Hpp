import { describe, expect, it } from "vitest";
import {
  buildFencedCode,
  detectCodeLanguage,
  formatCodeForDisplay,
  hasCodeFence,
  looksLikeCode,
  planUserMessageCode,
  splitCodeFences,
} from "./user-message-code";

describe("splitCodeFences", () => {
  it("splits text around fenced code and keeps the language tag", () => {
    const segments = splitCodeFences("看这里：\n```ts\nconst a = 1;\n```\n谢谢");

    expect(segments).toEqual([
      { type: "text", text: "看这里：" },
      { type: "code", code: "const a = 1;", language: "ts" },
      { type: "text", text: "谢谢" },
    ]);
  });

  it("keeps unclosed fences as plain text so typing is not swallowed", () => {
    expect(splitCodeFences("```js\nconst a = 1;")).toEqual([
      { type: "text", text: "```js\nconst a = 1;" },
    ]);
  });

  it("supports tilde fences and empty language", () => {
    expect(splitCodeFences("~~~\nx = 1\n~~~")).toEqual([
      { type: "code", code: "x = 1", language: "" },
    ]);
  });

  it("ignores junk language tags", () => {
    expect(splitCodeFences("```not a language\nx\n```")).toEqual([
      { type: "code", code: "x", language: "not" },
    ]);
    expect(splitCodeFences("```\u4ee3\u7801\nx\n```")[0]).toMatchObject({ language: "" });
  });

  it("reports whether a fence is present at all", () => {
    expect(hasCodeFence("```\nx\n```")).toBe(true);
    expect(hasCodeFence("普通文本")).toBe(false);
  });
});

describe("looksLikeCode", () => {
  it("recognises a typical pasted snippet", () => {
    expect(looksLikeCode([
      "const [count, setCount] = useState(0);",
      "useEffect(() => {",
      "  setCount(1);",
      "}, []);",
    ].join("\n"))).toBe(true);
  });

  it("recognises single-line code only when it carries strong signals", () => {
    expect(looksLikeCode("const foo = bar;")).toBe(true);
    expect(looksLikeCode("items.map((item) => item.id)")).toBe(true);
    expect(looksLikeCode("这个函数叫什么名字")).toBe(false);
    expect(looksLikeCode("我要改一下导入顺序")).toBe(false);
  });

  it("does not turn Chinese prose that mentions code keywords into code", () => {
    const prose = [
      "帮我看看这个报错：",
      "import 的时候提示找不到模块。",
      "应该怎么改？",
    ].join("\n");

    expect(looksLikeCode(prose)).toBe(false);
  });

  it("ignores text that already has fences or is too long", () => {
    expect(looksLikeCode("```ts\nconst a = 1;\n```")).toBe(false);
    expect(looksLikeCode(`const a = 1;\n${"x;\n".repeat(3000)}`)).toBe(false);
  });

  it("recognises pretty-printed JSON", () => {
    expect(looksLikeCode('{\n  "name": "hpp",\n  "version": "0.1.7"\n}')).toBe(true);
  });
});

describe("detectCodeLanguage", () => {
  it("guesses the common cases", () => {
    expect(detectCodeLanguage("const a = 1;\nconsole.log(a);")).toBe("javascript");
    expect(detectCodeLanguage("interface A {\n  b: string;\n}")).toBe("typescript");
    expect(detectCodeLanguage("def run():\n    return 1")).toBe("python");
    expect(detectCodeLanguage("#include <stdio.h>\nint main() {}")).toBe("c");
    expect(detectCodeLanguage('{\n  "a": 1\n}')).toBe("json");
    expect(detectCodeLanguage("SELECT * FROM users")).toBe("sql");
    expect(detectCodeLanguage("<div class=\"a\"></div>")).toBe("html");
    expect(detectCodeLanguage("随便什么")).toBe("");
  });
});

describe("buildFencedCode", () => {
  it("grows the fence when the code itself contains backticks", () => {
    const fenced = buildFencedCode("const s = ```inner```;", "ts");

    expect(fenced.startsWith("````ts")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
    // 内容原样保留，不会被内层的 ``` 提前截断。
    expect(splitCodeFences(fenced)[0]).toMatchObject({
      type: "code",
      code: "const s = ```inner```;",
    });
  });
});

describe("planUserMessageCode", () => {
  it("keeps prose as plain text", () => {
    expect(planUserMessageCode("帮我改一下这个文件的导入顺序").kind).toBe("plain");
  });

  it("turns a bare snippet into one code segment", () => {
    const plan = planUserMessageCode("const a = 1;\nconst b = 2;");

    expect(plan).toEqual({
      kind: "segments",
      segments: [{ type: "code", code: "const a = 1;\nconst b = 2;", language: "javascript" }],
    });
  });

  it("still renders explicit fences when auto-detection is off", () => {
    const plan = planUserMessageCode("```ts\nconst a = 1;\n```", { autoDetect: false });

    expect(plan.kind).toBe("segments");
    expect(planUserMessageCode("const a = 1;\nconst b = 2;", { autoDetect: false }).kind).toBe("plain");
  });
});

describe("formatCodeForDisplay", () => {
  const pasted = [
    "//测试代码块，你不用理",
    "if (spacing.x < 0 || spacing.y < 0 || float.IsNaN(spacing.x) ||",
    "                float.IsNaN(spacing.y) || float.IsInfinity(spacing.x) || float.IsInfinity(spacing.y))",
    "            {",
    "                EditorGUILayout.HelpBox(\"间距必须为有限非负数。\", MessageType.Error);",
    "                return;",
    "            }",
  ].join("\n");

  it("re-indents a pasted brace-language block with broken indentation", () => {
    expect(formatCodeForDisplay(pasted, "")).toBe([
      "//测试代码块，你不用理",
      "if (spacing.x < 0 || spacing.y < 0 || float.IsNaN(spacing.x) ||",
      "    float.IsNaN(spacing.y) || float.IsInfinity(spacing.x) || float.IsInfinity(spacing.y))",
      "{",
      "    EditorGUILayout.HelpBox(\"间距必须为有限非负数。\", MessageType.Error);",
      "    return;",
      "}",
    ].join("\n"));
  });

  it("uses two spaces for js/ts style languages and four elsewhere", () => {
    const js = "function a() {\nreturn 1;\n}";
    expect(formatCodeForDisplay(js, "javascript")).toBe("function a() {\n  return 1;\n}");
    expect(formatCodeForDisplay(js, "csharp")).toBe("function a() {\n    return 1;\n}");
    expect(formatCodeForDisplay(js, "java")).toBe("function a() {\n    return 1;\n}");
  });

  it("never touches indentation-sensitive languages", () => {
    const python = "def run():\n    if ok:\n        return 1\n    return 0";
    expect(formatCodeForDisplay(python, "python")).toBe(python);
    expect(formatCodeForDisplay("a:\n  b: 1", "yaml")).toBe("a:\n  b: 1");
    expect(formatCodeForDisplay("if a; then\n  echo 1\nfi", "bash")).toBe("if a; then\n  echo 1\nfi");
  });

  it("leaves unknown-language text alone when there are no braces at all", () => {
    const pythonWithoutTag = "for x in items:\n        total += x";
    expect(formatCodeForDisplay(pythonWithoutTag, "")).toBe(pythonWithoutTag);
  });

  it("ignores braces inside strings and comments", () => {
    const code = [
      "const msg = \"}\";",
      "// } 这里只是注释",
      "if (a) {",
      "/* 多行注释里的 } 也不算",
      "   仍然在块里 */",
      "  b();",
      "}",
    ].join("\n");

    expect(formatCodeForDisplay(code, "javascript")).toBe([
      "const msg = \"}\";",
      "// } 这里只是注释",
      "if (a) {",
      "  /* 多行注释里的 } 也不算",
      "  仍然在块里 */",
      "  b();",
      "}",
    ].join("\n"));
  });

  it("keeps empty lines empty instead of padding them", () => {
    expect(formatCodeForDisplay("if (a) {\n\n  b();\n}", "javascript"))
      .toBe("if (a) {\n\n  b();\n}");
  });

  it("gives up on oversized code", () => {
    const huge = "x;\n".repeat(500);
    expect(formatCodeForDisplay(huge, "javascript")).toBe(huge);
  });
});
