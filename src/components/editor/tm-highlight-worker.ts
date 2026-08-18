/**
 * TextMate 语法高亮 Worker（VSCode 同款引擎 vscode-textmate + oniguruma）。
 *
 * 职责：
 * 1. 初始化 oniguruma wasm 与 grammar registry（C# / Lua / 最小 C 兜底）
 * 2. 接收文档行数组，用 grammar.tokenizeLine 逐行 tokenize（状态机跨行保持）
 * 3. 把 scope 名映射为稳定的 class 名（cm-tm-*），主线程直接生成 decoration
 *
 * 全量 tokenize 在 worker 中执行，不阻塞 UI 线程。
 */
import { loadWASM, createOnigScanner, createOnigString } from "vscode-oniguruma";
import { Registry, parseRawGrammar, type IGrammar } from "vscode-textmate";
import { ONIG_WASM_BASE64 } from "./onig-wasm-base64";
import csharpGrammar from "./grammars/csharp.tmLanguage.plist?raw";
import luaGrammar from "./grammars/lua.tmLanguage.json?raw";

export interface TmWorkerToken {
  from: number;
  to: number;
  cls: string;
}

export type TmWorkerLine = TmWorkerToken[];

interface TmRequestBase {
  id: number;
  type: "init" | "tokenize";
}

interface TmTokenizeRequest extends TmRequestBase {
  type: "tokenize";
  language: "lua" | "cs";
  lines: string[];
}

type TmWorkerRequest = TmTokenizeRequest | TmRequestBase;

/** Lua 语法中 FFI/C 内嵌代码块（ffi.cdef）include 的 source.c 兜底 grammar。 */
const MIN_C_GRAMMAR = JSON.stringify({
  scopeName: "source.c",
  patterns: [
    { include: "#comment" },
    { include: "#string" },
    { include: "#keyword" },
    { include: "#number" },
  ],
  repository: {
    comment: {
      patterns: [
        { begin: "/\\*", end: "\\*/", name: "comment.block.c" },
        { begin: "//", end: "$", name: "comment.line.double-slash.c" },
      ],
    },
    string: {
      patterns: [
        { begin: '"', end: '"', name: "string.quoted.double.c" },
        { begin: "'", end: "'", name: "string.quoted.single.c" },
      ],
    },
    keyword: {
      patterns: [
        {
          match:
            "\\b(int|char|long|short|float|double|void|unsigned|signed|struct|typedef|enum|union|const|static|if|else|for|while|do|return|break|continue|switch|case|default|sizeof|include|define)\\b",
          name: "keyword.control.c",
        },
      ],
    },
    number: {
      patterns: [{ match: "\\b[0-9]+(\\.[0-9]+)?([uUlLfF])?\\b", name: "constant.numeric.c" }],
    },
  },
});

/**
 * scope → class 映射，顺序敏感（specific 在前）。
 * 语义对齐 VSCode Dark+/Light+ 主题的核心规则。
 */
const SCOPE_RULES: Array<[RegExp, string]> = [
  // 注释
  [/^comment/, "comment"],
  // 字符串 / 转义
  [/^string/, "string"],
  [/^constant\.character\.escape/, "string"],
  // 数字 / 字面量
  [/^constant\.numeric/, "number"],
  [/^constant\.language/, "keyword"],
  [/^constant\.other/, "constant"],
  [/^constant/, "constant"],
  // 关键字（operator 单独映射）
  [/^keyword\.control/, "keyword"],
  [/^keyword\.other/, "keyword"],
  [/^keyword\.operator/, "operator"],
  [/^keyword/, "keyword"],
  // 存储类型/修饰符
  [/^storage\.type/, "type"],
  [/^storage\.modifier/, "keyword"],
  [/^storage/, "keyword"],
  // 类型 / 类 / 命名空间
  [/^entity\.name\.type/, "type"],
  [/^entity\.name\.class/, "type"],
  [/^entity\.name\.(struct|enum|interface|namespace|module)/, "type"],
  [/^support\.type/, "type"],
  // 函数 / 方法
  [/^entity\.name\.(function|method)/, "function"],
  [/^support\.function/, "function"],
  [/^variable\.function/, "function"],
  // 属性 / 字段
  [/^variable\.other\.property/, "property"],
  [/^variable\.object\.property/, "property"],
  [/^support\.property/, "property"],
  [/^meta\.property/, "property"],
  // 参数
  [/^variable\.parameter/, "parameter"],
  [/^meta\.parameter/, "parameter"],
  // 通用变量
  [/^variable/, "variable"],
  [/^support\.constant/, "constant"],
  [/^support/, "variable"],
  // 其他命名（声明处名字）
  [/^entity\.name\.label/, "label"],
  [/^entity\.name/, "variable"],
  // 预处理指令 / 宏
  [/^meta\.preprocessor/, "preprocessor"],
  // 内嵌代码
  [/^meta\.embedded/, "string"],
  [/^meta/, "text"],
  // 标点 / 操作符
  [/^punctuation/, "punctuation"],
  // 标记语言
  [/^markup\.underline\.link/, "link"],
  [/^markup\.bold/, "strong"],
  [/^markup\.italic/, "emphasis"],
  [/^markup\.heading/, "heading"],
  [/^markup/, "text"],
];

function scopeToClass(scope: string): string {
  for (const [regex, cls] of SCOPE_RULES) {
    if (regex.test(scope)) return cls;
  }
  return "text";
}

let registryPromise: Promise<Registry> | null = null;

function getRegistry(): Promise<Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      console.log("[TextMate-worker] 开始初始化 oniguruma wasm...");
      const wasmBytes = Uint8Array.from(atob(ONIG_WASM_BASE64), (char) => char.charCodeAt(0));
      await loadWASM(wasmBytes);
      console.log("[TextMate-worker] wasm 加载成功");
      const registry = new Registry({
        onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
        loadGrammar: async (scopeName: string) => {
          if (scopeName === "source.cs") {
            return parseRawGrammar(csharpGrammar, "csharp.tmLanguage.plist");
          }
          if (scopeName === "source.lua") {
            return parseRawGrammar(luaGrammar, "lua.tmLanguage.json");
          }
          if (scopeName === "source.c") {
            return parseRawGrammar(MIN_C_GRAMMAR, "c.tmLanguage.json");
          }
          return null;
        },
      });
      console.log("[TextMate-worker] registry 就绪");
      return registry;
    })().catch((err) => {
      console.error("[TextMate-worker] 初始化失败:", err);
      throw err;
    });
  }
  return registryPromise;
}

const grammarCache = new Map<string, IGrammar>();

async function loadGrammar(language: "lua" | "cs"): Promise<IGrammar> {
  const scopeName = language === "cs" ? "source.cs" : "source.lua";
  const cached = grammarCache.get(scopeName);
  if (cached) return cached;
  const registry = await getRegistry();
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) throw new Error(`TextMate grammar not found: ${scopeName}`);
  grammarCache.set(scopeName, grammar);
  return grammar;
}

function tokenizeLines(grammar: IGrammar, lines: string[]): TmWorkerLine[] {
  let prevState: Parameters<IGrammar["tokenizeLine"]>[1] = null;
  const result: TmWorkerLine[] = [];
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, prevState);
    prevState = r.ruleStack;
    const tokens: TmWorkerToken[] = [];
    for (const t of r.tokens) {
      if (t.startIndex >= t.endIndex) continue;
      const scope = t.scopes[t.scopes.length - 1] ?? "";
      const cls = scopeToClass(scope);
      if (cls !== "text") {
        tokens.push({ from: t.startIndex, to: t.endIndex, cls });
      }
    }
    result.push(tokens);
  }
  return result;
}

self.onmessage = async (event: MessageEvent<TmWorkerRequest>) => {
  const { id, type } = event.data;
  try {
    if (type === "tokenize") {
      const { language, lines } = event.data as TmTokenizeRequest;
      const grammar = await loadGrammar(language);
      const tokens = tokenizeLines(grammar, lines);
      const total = tokens.reduce((sum, line) => sum + line.length, 0);
      console.log(`[TextMate-worker] ${language} tokenize 完成: ${lines.length} 行, ${total} 个 token`);
      self.postMessage({ id, ok: true, tokens });
    } else {
      await getRegistry();
      self.postMessage({ id, ok: true });
    }
  } catch (err: unknown) {
    console.error("[TextMate-worker] 请求失败:", err);
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
