import { normalizeDiffPath, toProjectRelativePath } from "./diff-summary";
import type { DiffLike } from "./diff-summary";

export type ReviewLineType = "context" | "del" | "add";

export interface ReviewSplitLine {
  type: ReviewLineType;
  text: string;
  leftLineNo?: number;
  rightLineNo?: number;
}

export type ReviewFileStatus = "added" | "deleted" | "modified";

export interface ReviewFileDiff {
  /** 原始文件路径（用于在文件管理器中定位 / 打开）。 */
  file: string;
  /** 相对项目路径的展示名。 */
  displayFile: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  /** 是否有可解析的补丁。 */
  hasPatch: boolean;
  /** 合并后的原始补丁文本（用于还原完整文件对比）。 */
  patch: string;
  /** 同一文件各次修改的原始补丁，按产生顺序保存，撤销时需逆序应用。 */
  patches: string[];
  /** 补丁内按顺序排列的行（patch-only 渲染回退）。 */
  lines: ReviewSplitLine[];
}

/** 完整文件对比中的一个单元格（一侧的一行）。 */
export interface DiffLineCell {
  lineNo: number;
  type: ReviewLineType;
  text: string;
}

/** 左右对齐的一行对比。新增/删除行只出现在其中一侧。 */
export interface FullDiffPair {
  left?: DiffLineCell;
  right?: DiffLineCell;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: ReviewSplitLine[];
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const DEV_NULL_OLD = /^---\s+\/dev\/null\b/;
const DEV_NULL_NEW = /^\+\+\+\s+\/dev\/null\b/;

const isPatchHeaderLine = (raw: string) =>
  raw.startsWith("diff --git")
  || raw.startsWith("index ")
  || raw.startsWith("new file")
  || raw.startsWith("deleted file")
  || /^---\s/.test(raw)
  || /^\+\+\+\s/.test(raw);

/**
 * 解析 unified diff 补丁为 hunk 列表，每个 hunk 携带旧/新文件起始行号与内容行。
 * 容错：空补丁、仅元数据、无 hunk 等场景均返回空数组，不抛异常。
 */
export function parsePatchHunks(patch: string): PatchHunk[] {
  if (!patch || !patch.trim()) return [];
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let leftLineNo = 1;
  let rightLineNo = 1;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    if (isPatchHeaderLine(raw)) continue;

    if (raw.startsWith("@@")) {
      const match = HUNK_HEADER.exec(raw);
      if (match) {
        current = {
          oldStart: Number(match[1]),
          oldCount: Number(match[2] ?? 1),
          newStart: Number(match[3]),
          newCount: Number(match[4] ?? 1),
          rows: [],
        };
        hunks.push(current);
        leftLineNo = current.oldStart;
        rightLineNo = current.newStart;
      }
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    // "\ No newline at end of file" 标记。
    if (raw.startsWith("\\")) continue;

    if (raw.startsWith("-")) {
      current.rows.push({ type: "del", text: raw.slice(1), leftLineNo: leftLineNo });
      leftLineNo += 1;
    } else if (raw.startsWith("+")) {
      current.rows.push({ type: "add", text: raw.slice(1), rightLineNo: rightLineNo });
      rightLineNo += 1;
    } else if (raw.startsWith(" ")) {
      current.rows.push({
        type: "context",
        text: raw.slice(1),
        leftLineNo: leftLineNo,
        rightLineNo: rightLineNo,
      });
      leftLineNo += 1;
      rightLineNo += 1;
    }
  }

  return hunks;
}

/**
 * 解析单个 unified diff 补丁，产出供「并排对比 / 统一视图」共用的行结构。
 * 容错：空补丁、仅元数据、无 hunk 等场景均返回安全结果，不抛异常。
 */
export function splitPatch(patch: string): { lines: ReviewSplitLine[]; status: ReviewFileStatus } {
  const lines: ReviewSplitLine[] = [];
  if (!patch || !patch.trim()) return { lines, status: "modified" };

  for (const hunk of parsePatchHunks(patch)) lines.push(...hunk.rows);

  const rawLines = patch.split("\n");
  let status: ReviewFileStatus = "modified";
  if (rawLines.some((line) => DEV_NULL_OLD.test(line))) status = "added";
  else if (rawLines.some((line) => DEV_NULL_NEW.test(line))) status = "deleted";

  // 无 /dev/null 头的补丁：根据内容推断整体状态（纯新增 / 纯删除）。
  if (status === "modified" && lines.length > 0) {
    const hasDel = lines.some((line) => line.type === "del");
    const hasAdd = lines.some((line) => line.type === "add");
    if (!hasDel && hasAdd) status = "added";
    else if (!hasAdd && hasDel) status = "deleted";
  }

  return { lines, status };
}

/**
 * 基于当前文件内容 + 补丁，还原出「修改前 / 修改后」的完整对齐行对。
 * 未变化的区域以 context 行完整保留，因此审核时可看到文件的其他内容。
 * 补丁不可用（空 / 无 hunk）时整个文件按未变化处理。
 */
export function buildFullFileDiff(currentContent: string, patch: string): FullDiffPair[] {
  const currentLines = currentContent.split("\n");
  const hunks = parsePatchHunks(patch);
  if (hunks.length === 0) {
    return currentLines.map((text, index) => ({
      left: { lineNo: index + 1, type: "context" as const, text },
      right: { lineNo: index + 1, type: "context" as const, text },
    }));
  }

  const pairs: FullDiffPair[] = [];
  let oldNo = 1;
  let newNo = 1;
  let currentIdx = 0;

  for (const hunk of hunks) {
    // hunk 之前未变化的区域：从当前文件连续取行，左右行号同步推进。
    while (newNo < hunk.newStart && currentIdx < currentLines.length) {
      const text = currentLines[currentIdx];
      currentIdx += 1;
      pairs.push({
        left: { lineNo: oldNo, type: "context", text },
        right: { lineNo: newNo, type: "context", text },
      });
      oldNo += 1;
      newNo += 1;
    }

    for (const row of hunk.rows) {
      if (row.type === "context") {
        const text = currentLines[currentIdx] ?? "";
        currentIdx += 1;
        pairs.push({
          left: { lineNo: oldNo, type: "context", text },
          right: { lineNo: newNo, type: "context", text },
        });
        oldNo += 1;
        newNo += 1;
      } else if (row.type === "add") {
        const text = currentLines[currentIdx] ?? "";
        currentIdx += 1;
        pairs.push({ right: { lineNo: newNo, type: "add", text } });
        newNo += 1;
      } else {
        pairs.push({ left: { lineNo: oldNo, type: "del", text: row.text } });
        oldNo += 1;
      }
    }
  }

  // 末尾未变化的区域。
  while (currentIdx < currentLines.length) {
    const text = currentLines[currentIdx];
    currentIdx += 1;
    pairs.push({
      left: { lineNo: oldNo, type: "context", text },
      right: { lineNo: newNo, type: "context", text },
    });
    oldNo += 1;
    newNo += 1;
  }

  return pairs;
}

/**
 * 将补丁内的顺序行转为对齐行对（当无法读取文件内容时的回退渲染）。
 */
export function linesToPairs(lines: ReviewSplitLine[]): FullDiffPair[] {
  return lines.map((line) => {
    if (line.type === "del") {
      return { left: { lineNo: line.leftLineNo ?? 0, type: "del", text: line.text } };
    }
    if (line.type === "add") {
      return { right: { lineNo: line.rightLineNo ?? 0, type: "add", text: line.text } };
    }
    return {
      left: { lineNo: line.leftLineNo ?? 0, type: "context", text: line.text },
      right: { lineNo: line.rightLineNo ?? 0, type: "context", text: line.text },
    };
  });
}

interface ReviewFileAccumulator {
  file: string;
  patches: string[];
  additions: number;
  deletions: number;
  status: ReviewFileStatus;
}

/**
 * 从完整补丁中提取指定 hunk 的独立补丁文本。
 * 保留文件头（diff --git / index / --- / +++ 等）+ 指定 hunk 的原始内容行，
 * 使其可作为独立的 git patch 传递给 `git apply --reverse`。
 */
export function extractHunkPatch(patch: string, hunkIndex: number): string | null {
  if (!patch || !patch.trim()) return null;
  const lines = patch.split("\n");
  const header: string[] = [];
  const hunks: string[][] = [];
  let currentHunk: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = [line];
    } else if (currentHunk) {
      currentHunk.push(line);
    } else {
      header.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  if (hunkIndex < 0 || hunkIndex >= hunks.length) return null;
  return [...header, ...hunks[hunkIndex]].join("\n");
}

/**
 * 将合并补丁（patches.join("\n")）中的 hunk 下标定位回「具体某份原始补丁 + 补丁内 hunk 下标」。
 * 合并补丁的 hunk 顺序就是各补丁 hunk 顺序的拼接（文件头行会被解析器跳过），
 * 因此按各补丁的 hunk 数量累计即可精确还原归属。
 * 局部撤销必须据此从单份补丁提取 hunk：直接从合并补丁切分会把后续补丁的
 * 文件头（diff --git / --- / +++ 等）混入前一个 hunk 的正文，git apply 必然失败。
 */
export function splitHunkIndex(
  patches: string[],
  mergedHunkIndex: number,
): { patchIndex: number; hunkIndex: number } | null {
  if (mergedHunkIndex < 0) return null;
  let remaining = mergedHunkIndex;
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const count = parsePatchHunks(patches[patchIndex]).length;
    if (remaining < count) return { patchIndex, hunkIndex: remaining };
    remaining -= count;
  }
  return null;
}

const REVIEW_STATUS_KEYS: Record<string, ReviewFileStatus> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
};

/**
 * 将消息中的 diff 列表聚合为可渲染的审核文件列表。
 * 保留原始路径用于定位/打开；展示名使用相对项目路径；补丁按原始路径合并。
 * 同文件多次编辑的补丁会合并后统一解析，行号在各 hunk 边界处重置。
 */
export function buildReviewDiff(diffs: DiffLike[], projectPath?: string): ReviewFileDiff[] {
  const byFile = new Map<string, ReviewFileAccumulator>();
  for (const diff of diffs) {
    if (!diff || typeof diff.file !== "string" || !diff.file) continue;
    const key = normalizeDiffPath(diff.file).toLowerCase();
    let entry = byFile.get(key);
    if (!entry) {
      entry = {
        file: diff.file,
        patches: [],
        additions: 0,
        deletions: 0,
        status: "modified",
      };
      byFile.set(key, entry);
    }
    const status = REVIEW_STATUS_KEYS[diff.status || ""];
    if (status) entry.status = status;
    if (typeof diff.patch === "string" && diff.patch.trim()) {
      if (!entry.patches.includes(diff.patch)) entry.patches.push(diff.patch);
    } else {
      entry.additions += Math.max(0, diff.additions || 0);
      entry.deletions += Math.max(0, diff.deletions || 0);
    }
  }

  const result: ReviewFileDiff[] = [];
  for (const entry of byFile.values()) {
    const patch = entry.patches.join("\n");
    const { lines, status } = splitPatch(patch);
    const hasPatch = patch.trim().length > 0;
    const additions = hasPatch
      ? lines.reduce((sum, line) => sum + (line.type === "add" ? 1 : 0), 0)
      : entry.additions;
    const deletions = hasPatch
      ? lines.reduce((sum, line) => sum + (line.type === "del" ? 1 : 0), 0)
      : entry.deletions;
    // 没有任何增删的文件对审核没有意义，不展示在列表中。
    if (additions === 0 && deletions === 0) continue;
    result.push({
      file: entry.file,
      displayFile: toProjectRelativePath(entry.file, projectPath),
      status: hasPatch ? status : entry.status,
      additions,
      deletions,
      hasPatch,
      patch,
      patches: [...entry.patches],
      lines,
    });
  }

  result.sort((left, right) => left.displayFile.localeCompare(right.displayFile));
  return result;
}
