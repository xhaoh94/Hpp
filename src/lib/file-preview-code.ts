import powershell from "highlight.js/lib/languages/powershell";
import { common, createLowlight } from "lowlight";
// 搜索函数从 text-search.ts 导入（无 lowlight 依赖，可被 Worker 安全引用）。
export {
  findTextMatches,
  getNextSearchMatchIndex,
  isRegexValid,
  applyPreserveCase,
  escapeRegExp,
  type SearchMatch,
  type TextSearchOptions,
  type IndexedSearchMatch,
} from "./text-search";
import type { SearchMatch } from "./text-search";

export interface SyntaxToken {
  text: string;
  classNames: string[];
}

export interface DisplayToken extends SyntaxToken {
  matchIndex?: number;
}

export interface RenderWindow {
  startIndex: number;
  endIndex: number;
}

type HighlightNode = {
  type: string;
  value?: string;
  properties?: { className?: string | string[] };
  children?: HighlightNode[];
};

const highlighter = createLowlight(common);
highlighter.register("powershell", powershell);

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  cts: "typescript",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  ps1: "powershell",
  psd1: "powershell",
  psm1: "powershell",
  py: "python",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
  // highlight.js 的 ini 语法同时支持 TOML。
  toml: "ini",
};

function appendSyntaxToken(line: SyntaxToken[], text: string, classNames: string[]) {
  if (!text) return;
  const previous = line[line.length - 1];
  if (previous && previous.classNames.join(" ") === classNames.join(" ")) {
    previous.text += text;
    return;
  }
  line.push({ text, classNames });
}

function flattenHighlightedNodes(
  nodes: HighlightNode[],
  lines: SyntaxToken[][],
  inheritedClassNames: string[] = [],
) {
  for (const node of nodes) {
    if (node.type === "text") {
      const parts = (node.value || "").split("\n");
      parts.forEach((part, index) => {
        appendSyntaxToken(lines[lines.length - 1], part, inheritedClassNames);
        if (index < parts.length - 1) lines.push([]);
      });
      continue;
    }

    if (!node.children) continue;
    const ownClassName = node.properties?.className;
    const ownClassNames = Array.isArray(ownClassName)
      ? ownClassName.map(String)
      : ownClassName
        ? [String(ownClassName)]
        : [];
    flattenHighlightedNodes(node.children, lines, [...inheritedClassNames, ...ownClassNames]);
  }
}

function plainSyntaxLines(content: string): SyntaxToken[][] {
  return content.split("\n").map((line) => line ? [{ text: line, classNames: [] }] : []);
}

export function getFilePreviewLanguage(filePath: string): string | null {
  const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase() || "";
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex < 0) return null;
  return EXTENSION_LANGUAGES[fileName.slice(extensionIndex + 1)] || null;
}

export function buildHighlightedLines(content: string, language: string | null): SyntaxToken[][] {
  if (!language || !highlighter.registered(language)) return plainSyntaxLines(content);

  try {
    const tree = highlighter.highlight(language, content);
    const lines: SyntaxToken[][] = [[]];
    flattenHighlightedNodes(tree.children as HighlightNode[], lines);
    return lines.length === content.split("\n").length ? lines : plainSyntaxLines(content);
  } catch {
    return plainSyntaxLines(content);
  }
}

export function getRenderWindow(
  totalLines: number,
  targetLine: number,
  maximumLines: number,
): RenderWindow {
  if (totalLines <= maximumLines) return { startIndex: 0, endIndex: totalLines };
  const safeTargetIndex = Math.min(Math.max(targetLine - 1, 0), totalLines - 1);
  const maximumStart = totalLines - maximumLines;
  const startIndex = Math.min(
    Math.max(safeTargetIndex - Math.floor(maximumLines / 2), 0),
    maximumStart,
  );
  return { startIndex, endIndex: startIndex + maximumLines };
}

export function parseGoToLine(value: string, totalLines: number): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const lineNumber = Number(normalized);
  return Number.isSafeInteger(lineNumber) && lineNumber >= 1 && lineNumber <= totalLines
    ? lineNumber
    : null;
}

export function buildDisplayTokens(
  syntaxTokens: SyntaxToken[],
  matches: IndexedSearchMatch[],
): DisplayToken[] {
  const result: DisplayToken[] = [];
  let tokenStart = 0;

  const append = (token: DisplayToken) => {
    if (!token.text) return;
    const previous = result[result.length - 1];
    if (
      previous
      && previous.matchIndex === token.matchIndex
      && previous.classNames.join(" ") === token.classNames.join(" ")
    ) {
      previous.text += token.text;
      return;
    }
    result.push(token);
  };

  for (const token of syntaxTokens) {
    const tokenEnd = tokenStart + token.text.length;
    const boundaries = new Set([tokenStart, tokenEnd]);
    for (const match of matches) {
      if (match.startColumn > tokenStart && match.startColumn < tokenEnd) {
        boundaries.add(match.startColumn);
      }
      if (match.endColumn > tokenStart && match.endColumn < tokenEnd) {
        boundaries.add(match.endColumn);
      }
    }

    const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
      const start = orderedBoundaries[index];
      const end = orderedBoundaries[index + 1];
      const match = matches.find(
        (candidate) => candidate.startColumn <= start && candidate.endColumn >= end,
      );
      append({
        text: token.text.slice(start - tokenStart, end - tokenStart),
        classNames: token.classNames,
        matchIndex: match?.matchIndex,
      });
    }
    tokenStart = tokenEnd;
  }

  return result;
}
