/**
 * JSONC 解析：容忍行注释、块注释和尾逗号。
 *
 * pi 的 `~/.pi/agent/settings.json`、Zed 的 `tasks.json` 都是 JSONC ——
 * 用 `JSON.parse` 读它们会在尾逗号上报错（实测：pi 的 `packages` 数组末尾带逗号）。
 * 字符串里的 `//` 和 `,}` 必须原样保留，所以不能整段走正则。
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      // 尾逗号：跳过逗号，只保留后面的空白。
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    out += char;
  }

  return JSON.parse(out);
}

/** 读文件用的包装：去掉 pi/部分编辑器会写入的 BOM，失败时把文件路径带进错误里。 */
export function parseJsoncFileContent(text: string, filePath: string): unknown {
  try {
    return parseJsonc(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`解析 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
