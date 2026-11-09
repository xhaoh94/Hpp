/**
 * 用户发言里的代码识别。
 *
 * 聊天里的用户消息一直是纯文本展示（刻意不走 Markdown，避免 `#` 标题、
 * `*` 列表把字号和缩进搅乱）。这个模块只做一件很窄的事：找出「这段就是他
 * 贴/敲的代码」，交给代码块渲染；其余文本保持原样。
 *
 * 两条路径：
 * - 显式围栏（``` / ~~~）：用户自己标注了，一定按代码块渲染；
 * - 无围栏时的保守自动识别：只认强代码特征，且要求「整条消息都是代码」，
 *   宁可漏判也不要把一段中文说明渲染成代码块。
 */

export type UserMessageSegment =
  | { type: "text"; text: string }
  | { type: "code"; code: string; language: string };

/** 关掉无围栏的自动识别时，只有显式 ``` 围栏才会渲染成代码块。 */
export const AUTO_DETECT_USER_CODE = true;

/** 超过这个长度的文本交给粘贴折叠/普通文本处理，不再尝试识别代码。 */
const AUTO_DETECT_MAX_CHARS = 6000;
/** 自动识别要求至少这么多「像代码」的行。 */
const AUTO_DETECT_MIN_CODE_LINES = 2;
/** 像代码的行占比低于这个值就当普通文本。 */
const AUTO_DETECT_MIN_RATIO = 0.6;

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})[ \t]*([^`~]*)$/;
const LANGUAGE_TAG = /^[a-zA-Z0-9+#._-]{1,24}$/;

/** 语言标签白名单：只接受短小的标识符，避免把奇怪内容拼进围栏。 */
const normalizeLanguage = (raw: string) => {
  const first = raw.trim().split(/\s+/)[0] || "";
  return LANGUAGE_TAG.test(first) ? first.toLowerCase() : "";
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 按 ``` / ~~~ 围栏切分文本。未闭合的围栏按普通文本处理（正在输入时很常见），
 * 这样流式输入不会突然吞掉后半段内容。
 */
export function splitCodeFences(text: string): UserMessageSegment[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const segments: UserMessageSegment[] = [];
  let buffer: string[] = [];
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    segments.push({ type: "text", text: buffer.join("\n") });
    buffer = [];
  };

  let index = 0;
  while (index < lines.length) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open) {
      buffer.push(lines[index]);
      index += 1;
      continue;
    }
    const marker = open[1];
    const closePattern = new RegExp(`^\\s{0,3}${escapeRegExp(marker[0])}{${marker.length},}\\s*$`);
    let closeIndex = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      if (closePattern.test(lines[scan])) {
        closeIndex = scan;
        break;
      }
    }
    if (closeIndex === -1) {
      // 未闭合：原样当文本，等用户写完再说。
      buffer.push(lines[index]);
      index += 1;
      continue;
    }
    flushBuffer();
    segments.push({
      type: "code",
      code: lines.slice(index + 1, closeIndex).join("\n"),
      language: normalizeLanguage(open[2] || ""),
    });
    index = closeIndex + 1;
  }
  flushBuffer();
  return segments;
}

/** 文本里是否含显式代码围栏（含未闭合的）。 */
export function hasCodeFence(text: string): boolean {
  return /^\s{0,3}(?:`{3,}|~{3,})/m.test(text);
}

const CODE_LINE_PATTERNS: RegExp[] = [
  // 声明 / 定义
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+\w+/,
  /^\s*(?:const|let|var)\s+[\w$[{]/,
  /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\]]+\s+\w+\s*\(/,
  /^\s*def\s+\w+\s*\(/,
  /^\s*#\s*include\s*[<"]/,
  /^\s*(?:package|using|namespace)\s+[\w.]+/,
  /\bimpl\s+\w+/,
  /^\s*fn\s+\w+/,
  // 导入 / 导出
  /^\s*import\s+.+from\s+['"]/,
  /^\s*(?:from\s+\S+\s+)?import\s+[\w.*{]/,
  /^\s*require\s*\(/,
  // 控制流 / 语句
  /^\s*(?:if|for|while|switch|catch|try|else|return|throw|await|async)\b.*[)\];{]$/,
  /^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i,
  // 结构符号
  /^\s*[}\])];?\s*$/,
  /^\s*[<{[]/,
  /^\s*"[^"]+"\s*:/,
  /^\s*[\w.[\]]+\s*(?:=|\+=|-=|\|\|=|\?\?=)\s*[^=]/,
  /^\s*[\w.[\]]+\(.*\)\s*;?\s*$/,
  /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?>/i,
  /^\s*#!\/.*(?:sh|bash|node|python)/,
  /;\s*$/,
  /=>/,
];

const countCodeLines = (lines: string[]) =>
  lines.filter((line) => CODE_LINE_PATTERNS.some((pattern) => pattern.test(line))).length;

/**
 * 无围栏时判断「这条消息整段就是代码」。
 * 判据刻意保守：多行 + 代码特征行占比达标 + 单行时必须有分号/箭头/括号等
 * 强信号，避免把正常的中文说明（尤其是开头带 `import`、`const` 字样的句子）
 * 误判成代码。
 */
export function looksLikeCode(text: string): boolean {
  if (!AUTO_DETECT_USER_CODE) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > AUTO_DETECT_MAX_CHARS) return false;
  if (hasCodeFence(trimmed)) return false;
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;

  if (lines.length === 1) {
    const line = lines[0].trim();
    if (line.length < 6) return false;
    // 单行要有 unmistakable 的代码痕迹：结尾分号、箭头函数、赋值+调用、标签。
    return /;\s*$/.test(line)
      || /=>/.test(line)
      || /^[\w.[\]]+\s*=\s*\S/.test(line)
      || /^<\/?[a-z][\w-]*[\s>]/i.test(line)
      || /^#!\/.*(?:sh|bash|node|python)/.test(line);
  }

  if (lines.length < AUTO_DETECT_MIN_CODE_LINES) return false;
  const codeLines = countCodeLines(lines);
  const ratio = codeLines / lines.length;
  if (ratio < AUTO_DETECT_MIN_RATIO) return false;
  // 结尾是中文句号/问号/感叹号，通常说明这是自然语言段落而不是代码。
  const tail = lines[lines.length - 1].trim();
  if (/[。！？]$/.test(tail) && ratio < 0.85) return false;
  return true;
}

/** 根据强特征猜一个语言标签，猜不出就留空（代码块仍会渲染，跳过高亮）。 */
export function detectCodeLanguage(code: string): string {
  const text = code.trim();
  if (!text) return "";
  if (/^\s*#\s*include\s*[<"]|^\s*int\s+main\s*\(/m.test(text)) return "c";
  if (/^\s*#!\/.*(?:bash|sh)\b/m.test(text)) return "bash";
  if (/^\s*#!\/.*node/m.test(text)) return "javascript";
  if (/^\s*#!\/.*python/m.test(text)) return "python";
  if (/^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/im.test(text)) return "sql";
  if (/^\s*(?:package|func)\s+\w+|^\s*import\s+\(/m.test(text)) return "go";
  if (/^\s*(?:public\s+)?(?:class|interface)\s+\w+[\s\S]*\bpublic\s+static\s+void\s+main\b/m.test(text)) return "java";
  if (/^\s*(?:using\s+System|namespace\s+\w+)/m.test(text)) return "csharp";
  if (/^\s*(?:def|import|from)\s+\w+[\s\S]*:\s*$/m.test(text) && !/[;{]\s*$/m.test(text)) return "python";
  if (/^\s*<\?php|\$\w+\s*=/m.test(text)) return "php";
  if (/^\s*<(!doctype|html|div|span|template|script)/im.test(text)) return "html";
  if (/^\s*(?:FROM|RUN|CMD|ENTRYPOINT|WORKDIR|COPY)\s+/m.test(text)) return "dockerfile";
  if (/^\s*(?:import|export)\s+\{[^}]*\}\s+from\s+['"]/m.test(text) && /:\s*(?:string|number|boolean)\b/.test(text)) {
    return "typescript";
  }
  if (/^\s*(?:interface|type)\s+\w+\s*(?:=|\{)/m.test(text) && /:\s*[\w<>[\]]+/.test(text)) {
    return "typescript";
  }
  if (/^\s*(?:import|export)\s/m.test(text) || /\bconst\b|\bfunction\b|=>|console\./.test(text)) {
    return "javascript";
  }
  if (/^\s*[{[]/.test(text) && /"\s*:/.test(text)) return "json";
  if (/^\s*[\w-]+:\s*\S/m.test(text) && /^\s*-\s+/m.test(text)) return "yaml";
  return "";
}

/**
 * 把代码包成 Markdown 围栏，供 MarkdownRenderer 复用现成的代码块
 * （表头、复制、运行、高亮都由它负责）。围栏长度按内容里最长的反引号
 * 序列动态加长，代码里出现 ``` 也不会截断。
 */
export function buildFencedCode(code: string, language = ""): string {
  const longestRun = (code.match(/`{3,}/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

export type UserMessageCodePlan = { kind: "plain" } | { kind: "segments"; segments: UserMessageSegment[] };

export type PlanUserMessageCodeOptions = {
  /**
   * 是否允许「无围栏时整段自动识别为代码」。
   * 只在整条消息都是文本时开启；夹着附件芯片/多段文本的消息关掉，
   * 避免把消息中间的一小段文字误判成代码块而打断行内排版。
   */
  autoDetect?: boolean;
};

/**
 * 渲染计划：
 * - 有围栏 → 逐段切分（文本段仍是纯文本，代码段走代码块）；
 * - 无围栏但整条像代码 → 整条作为单个代码段；
 * - 其余 → 纯文本，保持既有观感。
 */
export function planUserMessageCode(
  text: string,
  options: PlanUserMessageCodeOptions = {},
): UserMessageCodePlan {
  if (!text) return { kind: "plain" };
  const autoDetect = options.autoDetect !== false;
  if (hasCodeFence(text)) {
    const segments = splitCodeFences(text);
    return segments.some((segment) => segment.type === "code")
      ? { kind: "segments", segments }
      : { kind: "plain" };
  }
  if (autoDetect && looksLikeCode(text)) {
    return {
      kind: "segments",
      segments: [{ type: "code", code: text.replace(/\s+$/, ""), language: detectCodeLanguage(text) }],
    };
  }
  return { kind: "plain" };
}

/* -------------------------------------------------------------------------- */
/*  缩进重排（自动格式化）                                                      */
/* -------------------------------------------------------------------------- */

/** 关掉「代码块自动重排缩进」时，代码块只按原样展示。 */
export const AUTO_FORMAT_USER_CODE = true;

/** 只重排缩进，不改行内空白、不拆行；超过这个体量就放弃（避免长代码卡顿）。 */
const FORMAT_MAX_LINES = 400;
const FORMAT_MAX_CHARS = 40_000;

/** 明确用花括号表达块结构的语言：这些语言重新缩进是安全的。 */
const BRACE_LANGUAGES = new Set([
  "javascript", "js", "jsx", "mjs", "cjs",
  "typescript", "ts", "tsx",
  "json", "jsonc", "json5",
  "java", "csharp", "cs", "c", "cpp", "c++", "h", "hpp", "cc",
  "go", "golang", "rust", "rs", "php", "kotlin", "kt", "swift",
  "scala", "dart", "groovy", "objc", "objective-c", "mm",
  "css", "scss", "less", "vue", "svelte",
]);

/** 缩进敏感或非花括号语言：绝对不能碰缩进。 */
const INDENT_SENSITIVE_LANGUAGES = new Set([
  "python", "py", "yaml", "yml", "markdown", "md", "text", "txt", "plaintext",
  "sh", "bash", "shell", "zsh", "fish", "powershell", "ps1", "bat", "cmd",
  "ruby", "rb", "perl", "pl", "makefile", "make", "dockerfile", "haskell", "hs",
  "elixir", "ex", "erlang", "fsharp", "fs", "nim", "crystal",
]);

const INDENT_SIZE_BY_LANGUAGE: Record<string, number> = {
  javascript: 2, js: 2, jsx: 2, mjs: 2, cjs: 2,
  typescript: 2, ts: 2, tsx: 2,
  json: 2, jsonc: 2, json5: 2,
  html: 2, htm: 2, xml: 2, vue: 2, svelte: 2,
  css: 2, scss: 2, less: 2,
};

const LEADING_CLOSER = /^[}\])]/;

type LineScan = {
  braceDelta: number;
  parenDelta: number;
};

/**
 * 轻量词法扫描：只关心「这一行裸露出多少个花括号 / 圆括号」，
 * 跳过字符串、行注释与跨行块注释，避免把 `"{"` 或注释里的括号算进去。
 */
function scanLineForBrackets(line: string, state: { inBlockComment: boolean }): LineScan {
  let braceDelta = 0;
  let parenDelta = 0;
  let quote: string | null = null;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    const next = line[index + 1];
    if (state.inBlockComment) {
      if (char === "*" && next === "/") {
        state.inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") break;
    if (char === "/" && next === "*") {
      state.inBlockComment = true;
      index += 2;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "{") braceDelta += 1;
    else if (char === "}") braceDelta -= 1;
    else if (char === "(" || char === "[") parenDelta += 1;
    else if (char === ")" || char === "]") parenDelta -= 1;
    index += 1;
  }
  return { braceDelta, parenDelta };
}

const getIndentSize = (language: string) => INDENT_SIZE_BY_LANGUAGE[language.toLowerCase()] ?? 4;

/**
 * 按花括号层级重新缩进代码（只改行首空白）。
 *
 * 为什么不做真正的 formatter：引入 prettier 这类依赖体积过大，而用户遇到的
 * 问题几乎都是「粘贴过来缩进乱了」。这个实现零依赖、对所有花括号语言通用，
 * 且不改变任何行内内容，最坏情况只是缩进没调好，不会改坏代码。
 */
export function formatCodeIndent(code: string, language = ""): string {
  const indentSize = getIndentSize(language);
  const lines = code.split(/\r?\n/);
  const state = { inBlockComment: false };
  let braceLevel = 0;
  let parenLevel = 0;

  const formatted = lines.map((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return "";
    const scan = scanLineForBrackets(trimmed, state);
    // 行首的 } ) ] 属于上一层，判定层级时先退一级。
    const closesFirst = LEADING_CLOSER.test(trimmed) ? 1 : 0;
    const baseLevel = Math.max(0, braceLevel - closesFirst);
    // 跨行括号里的续行退一级缩进，长条件/长参数列表才有可读性。
    const continuation = parenLevel > 0 ? 1 : 0;
    const indent = " ".repeat((baseLevel + continuation) * indentSize);
    braceLevel = Math.max(0, braceLevel + scan.braceDelta);
    parenLevel = Math.max(0, parenLevel + scan.parenDelta);
    return `${indent}${trimmed}`;
  });

  return formatted.join("\n");
}

/**
 * 代码块展示前是否 / 如何重排缩进：
 * - 语言已知且属于花括号语言 → 重排；
 * - 语言未知（猜不出来）→ 只有代码里出现花括号才重排，避免把 Python 这类
 *   靠缩进表达块结构的代码全部顶格；
 * - 缩进敏感语言、超大文本 → 原样返回。
 */
export function formatCodeForDisplay(code: string, language = ""): string {
  if (!AUTO_FORMAT_USER_CODE) return code;
  if (!code.trim()) return code;
  if (code.length > FORMAT_MAX_CHARS) return code;
  const normalized = language.toLowerCase();
  if (INDENT_SENSITIVE_LANGUAGES.has(normalized)) return code;

  const lines = code.split(/\r?\n/);
  if (lines.length > FORMAT_MAX_LINES) return code;

  if (!normalized) {
    // 猜不出语言时只信「有花括号」这一个信号。
    if (!/[{}]/.test(code)) return code;
  } else if (!BRACE_LANGUAGES.has(normalized)) {
    return code;
  }

  return formatCodeIndent(code, normalized);
}
