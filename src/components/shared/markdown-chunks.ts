/**
 * 把（可能仍在流式增长的）Markdown 正文拆成若干可独立渲染的块。
 *
 * 流式回复每 120ms 更新一次内容。如果每次都把整篇正文交给 react-markdown
 * 重新走 remark → rehype → 代码高亮，成本会随正文长度线性增长；而其中
 * 已经写完的前缀其实没有变化。按保守边界切块后，前缀块可以命中 React.memo，
 * 只有尾部块需要重新解析。
 *
 * 保守原则：**宁可少切（合并成更大的块），也不能切错**。列表、围栏代码块、
 * 表格、引用块中间被切开会让渲染结果与整篇解析不一致，所以只有当空行两侧
 * 都不是「可延续结构」时才切分。
 */

type FenceMarker = { char: string; length: number };

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const TABLE_ROW_RE = /^ {0,3}\|/;
const INDENTED_RE = /^(?:\t| {4,})/;
const SETEXT_RE = /^ {0,3}(?:=+|-+|_+)[ \t]*$/;
/** 链接/脚注定义（`[id]: url`、`[^1]: 说明`）会被整篇引用，不能跨块拆开。 */
const DEFINITION_RE = /^ {0,3}\[[^\]]+\]:/;
const HTML_BLOCK_START_RE = /^ {0,3}<[A-Za-z!/?]/;
const BLANK_RE = /^[ \t]*$/;

const isBlank = (line: string) => BLANK_RE.test(line);

const matchFenceOpen = (line: string): FenceMarker | null => {
  const match = FENCE_OPEN_RE.exec(line);
  if (!match) return null;
  return { char: match[1][0], length: match[1].length };
};

const closesFence = (line: string, fence: FenceMarker) => {
  const escaped = fence.char === "`" ? "`" : "~";
  const pattern = new RegExp(`^ {0,3}${escaped}{${fence.length},}[ \\t]*$`);
  return pattern.test(line);
};

/**
 * 以该行结尾的块是否可能继续到下一个空行之后（列表项、引用、表格行、缩进
 * 代码、setext 标题下划线、HTML 块）。围栏代码块的开始/闭合行不算，因为它们
 * 本身就是完整块边界。
 */
const isStructuralLine = (line: string): boolean => (
  LIST_ITEM_RE.test(line)
  || BLOCKQUOTE_RE.test(line)
  || TABLE_ROW_RE.test(line)
  || INDENTED_RE.test(line)
  || SETEXT_RE.test(line)
  || HTML_BLOCK_START_RE.test(line)
);

/** 文档里出现链接/脚注定义时放弃切分：定义与引用可能分布在不同块里。 */
const hasDocumentWideDefinition = (lines: string[]): boolean => {
  let fence: FenceMarker | null = null;
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = matchFenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    if (DEFINITION_RE.test(line)) return true;
  }
  return false;
};

/**
 * 按行区间切块。切分点只落在空行上，且空行归前一个块，块之间用换行拼接后
 * 与原文完全一致（内容无损）。
 */
export function splitMarkdownChunks(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (hasDocumentWideDefinition(lines)) return [content];

  const chunks: string[] = [];
  let start = 0;
  let fence: FenceMarker | null = null;
  let blankRunStart = -1;
  let previousNonBlank = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      if (closesFence(line, fence)) fence = null;
      if (line.trim()) previousNonBlank = line;
      // 围栏内部（包括其中的空行）不是合法切点。
      blankRunStart = -1;
      continue;
    }

    if (isBlank(line)) {
      if (blankRunStart < 0) blankRunStart = index;
      continue;
    }

    const fenceOpen = matchFenceOpen(line);
    if (fenceOpen) {
      fence = fenceOpen;
    }

    if (
      blankRunStart > start
      && !isStructuralLine(previousNonBlank)
      && !isStructuralLine(line)
    ) {
      chunks.push(lines.slice(start, blankRunStart).join("\n"));
      start = blankRunStart;
    }

    blankRunStart = -1;
    previousNonBlank = line;
  }

  chunks.push(lines.slice(start).join("\n"));
  return chunks;
}
