/** 解析工作区文件里的冲突标记，供内联三方合并编辑器与 UI 共用。 */

export interface GitConflictBlock {
  ours: string;
  /** diff3 风格才有；普通 merge 风格为 null。 */
  base: string | null;
  theirs: string;
  labels: { ours: string; base: string; theirs: string };
}

export type GitConflictSegment =
  | { kind: "text"; text: string }
  | { kind: "conflict"; index: number };

export interface ParsedConflictFile {
  segments: GitConflictSegment[];
  blocks: GitConflictBlock[];
  /** 有开无闭：文件不是标准冲突格式，此时整段按原文保留。 */
  malformed: boolean;
}

const OPEN = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const SEPARATOR = /^={7}$/;
const CLOSE = /^>{7}(?: (.*))?$/;

const splitLines = (content: string) => content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const bare = (line: string) => line.replace(/\r?\n$/, "");

export function parseConflictFile(content: string): ParsedConflictFile {
  const segments: GitConflictSegment[] = [];
  const blocks: GitConflictBlock[] = [];
  let malformed = false;
  let text: string[] = [];

  let state: "text" | "ours" | "base" | "theirs" = "text";
  let raw: string[] = [];
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];
  let labels = { ours: "", base: "", theirs: "" };

  const flushText = () => {
    if (text.length === 0) return;
    const value = text.join("");
    text = [];
    // 相邻文本段合并：标记残缺时会出现「前文 + 回退的原文」两段。
    const last = segments[segments.length - 1];
    if (last && last.kind === "text") last.text += value;
    else segments.push({ kind: "text", text: value });
  };

  for (const line of splitLines(content)) {
    const value = bare(line);
    if (state === "text") {
      const open = OPEN.exec(value);
      if (!open) {
        text.push(line);
        continue;
      }
      flushText();
      raw = [line];
      ours = [];
      base = [];
      theirs = [];
      labels = { ours: open[1] || "", base: "", theirs: "" };
      state = "ours";
      continue;
    }

    raw.push(line);
    // diff3 里 "=======" 出现在 base 段之后，两个状态都要接。
    if ((state === "ours" || state === "base") && SEPARATOR.test(value)) {
      state = "theirs";
      continue;
    }
    if (state === "ours" && BASE.test(value)) {
      labels.base = BASE.exec(value)?.[1] || "";
      state = "base";
      continue;
    }
    if (CLOSE.test(value)) {
      labels.theirs = CLOSE.exec(value)?.[1] || "";
      segments.push({ kind: "conflict", index: blocks.length });
      blocks.push({ ours: ours.join(""), base: base.length > 0 ? base.join("") : null, theirs: theirs.join(""), labels });
      state = "text";
      raw = [];
      continue;
    }
    (state === "ours" ? ours : state === "base" ? base : theirs).push(line);
  }

  // 标记没闭合（或写成 "<<<<<<<" 的真内容）时不猜，整段原样当文本。
  if (state !== "text") {
    malformed = true;
    text.push(...raw);
  }
  flushText();

  return { segments, blocks, malformed };
}

/** 按每个冲突块的解析结果拼回完整文件；缺失的解析结果回退到当前分支版本。 */
export function buildResolvedContent(parsed: ParsedConflictFile, resolutions: string[]): string {
  const parts: string[] = [];
  parsed.segments.forEach((segment, position) => {
    if (segment.kind === "text") {
      parts.push(segment.text);
      return;
    }
    let value = resolutions[segment.index] ?? parsed.blocks[segment.index]?.ours ?? "";
    // 缺行尾会把下一段拼进同一行。
    if (position < parsed.segments.length - 1 && value && !value.endsWith("\n")) value += "\n";
    parts.push(value);
  });
  return parts.join("");
}
