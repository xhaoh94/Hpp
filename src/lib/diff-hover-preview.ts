export type DiffPreviewLineKind = "context" | "header" | "add" | "del";

export type DiffPreviewLine = {
  text: string;
  kind: DiffPreviewLineKind;
  /** 上下文/删除行用旧文件行号，新增行用新文件行号。 */
  lineNumber?: number;
};

export const DIFF_HOVER_PREVIEW_MAX_LINES = 260;

const isHeaderLine = (line: string) =>
  line.startsWith("@@")
  || line.startsWith("diff --git")
  || line.startsWith("--- ")
  || line.startsWith("+++ ");

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

export const classifyDiffPreviewLine = (line: string): DiffPreviewLineKind => {
  if (isHeaderLine(line)) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
};

/**
 * 把该文件的补丁拼成悬浮预览用的行数组。
 * 悬停预览只是提示，不承担完整审核职责：超过上限时截断并报告剩余行数，
 * 避免展开一个超大补丁时把渲染线程卡住。
 */
export function buildDiffPreviewLines(
  patches: string[],
  maxLines = DIFF_HOVER_PREVIEW_MAX_LINES,
): { lines: DiffPreviewLine[]; hiddenCount: number } {
  // 同一文件可能来自多轮改动；去掉各段尾部的换行后用一个空行分隔，
  // 避免补丁之间粘连或出现连续空行。
  const joined = patches
    .map((patch) => patch.replace(/\s+$/, ""))
    .filter((patch) => patch.length > 0)
    .join("\n\n");
  const all = joined.length > 0 ? joined.split("\n") : [];
  const visible = all.slice(0, Math.max(0, maxLines));
  let oldLineNo: number | null = null;
  let newLineNo: number | null = null;
  const lines = visible.map((text): DiffPreviewLine => {
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) {
      oldLineNo = Number(hunk[1]);
      newLineNo = Number(hunk[2]);
      return { text, kind: "header" };
    }
    if (text.startsWith("diff --git")) {
      oldLineNo = null;
      newLineNo = null;
      return { text, kind: "header" };
    }
    if (oldLineNo !== null && newLineNo !== null) {
      if (text.startsWith("\\")) return { text, kind: "header" };
      if (text.startsWith("-")) {
        const lineNumber = oldLineNo;
        oldLineNo += 1;
        return { text, kind: "del", lineNumber };
      }
      if (text.startsWith("+")) {
        const lineNumber = newLineNo;
        newLineNo += 1;
        return { text, kind: "add", lineNumber };
      }
      if (text.startsWith(" ")) {
        const lineNumber = newLineNo;
        oldLineNo += 1;
        newLineNo += 1;
        return { text, kind: "context", lineNumber };
      }
    }
    return { text, kind: classifyDiffPreviewLine(text) };
  });
  return {
    lines,
    hiddenCount: Math.max(0, all.length - visible.length),
  };
}
