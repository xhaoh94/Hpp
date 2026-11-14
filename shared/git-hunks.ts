/** 从 unified diff 中拆分 hunk，供 hunk 级暂存和 UI 共用。 */

export interface GitPatchHunk {
  index: number;
  header: string;
  lines: string[];
}

export interface ParsedGitPatch {
  header: string[];
  hunks: GitPatchHunk[];
}

export function parseGitPatch(patch: string): ParsedGitPatch {
  const lines = String(patch || "").split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk < 0) return { header: lines, hunks: [] };

  const header = lines.slice(0, firstHunk);
  const hunks: GitPatchHunk[] = [];
  let current: GitPatchHunk | null = null;
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { index: hunks.length, header: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

export function buildGitPatchForHunks(parsed: ParsedGitPatch, indexes: number[]): string | null {
  const selected = [...new Set(indexes)]
    .map((index) => parsed.hunks.find((hunk) => hunk.index === index))
    .filter((hunk): hunk is GitPatchHunk => !!hunk);
  if (selected.length === 0 || selected.length !== indexes.length) return null;
  return `${[...parsed.header, ...selected.flatMap((hunk) => [hunk.header, ...hunk.lines])].join("\n")}\n`;
}
