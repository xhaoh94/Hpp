export type DiffPreviewLineKind = "context" | "header" | "add" | "del";

export type DiffPreviewLine = {
  text: string;
  kind: DiffPreviewLineKind;
};

export const DIFF_HOVER_PREVIEW_MAX_LINES = 260;

const isHeaderLine = (line: string) =>
  line.startsWith("@@")
  || line.startsWith("diff --git")
  || line.startsWith("---")
  || line.startsWith("+++");

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
  return {
    lines: visible.map((text) => ({ text, kind: classifyDiffPreviewLine(text) })),
    hiddenCount: Math.max(0, all.length - visible.length),
  };
}
