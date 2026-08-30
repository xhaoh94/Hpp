import { normalizeDiffPath, toProjectRelativePath } from "./diff-summary";
import type { DiffLike } from "./diff-summary";

export type ReviewLineType = "context" | "del" | "add";

export interface ReviewSplitLine {
  type: ReviewLineType;
  text: string;
  leftLineNo?: number;
  rightLineNo?: number;
  /**
   * 该行所属 hunk 在「合并补丁」中的全局序号（按 hunk 出现顺序 0、1、2...）。
   * 由 parsePatchHunks 在解析阶段写入，buildFullFileDiff / linesToPairs 透传到 pair，
   * 渲染时直接读 pair.hunkIdx 即可定位 hunk，避免事后用行号回算导致的归属错位。
   */
  hunkIdx?: number;
}

export type ReviewFileStatus = "added" | "deleted" | "modified";

export interface ReviewFileDiff {
  /** 原始文件路径（用于在文件管理器中定位 / 打开）。 */
  file: string;
  /** 相对项目路径的展示名。 */
  displayFile: string;
  status: ReviewFileStatus;
  /** status 是否由上游明确提供；headerless 补丁不能把内容形态推断当作文件生命周期。 */
  statusExplicit: boolean;
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
  /**
   * 该行所属 hunk 的全局序号（合并补丁中的位置），来自 parsePatchHunks。
   * 渲染「已撤销」样式、定位局部撤销按钮都靠它。
   */
  hunkIdx?: number;
  /**
   * 该行所属「修改点」在 hunk 内的序号。一个 hunk 可能含多个被上下文行分隔的
   * 修改点（连续的增删块），局部撤销以修改点为粒度，比 git hunk 更细。
   */
  changeIdx?: number;
  /**
   * 当前 pair 是不是其所属修改点的首个 pair（用于决定是否在该行渲染撤销按钮，
   * 避免同一修改点的每个增删行都冒一个按钮）。上下文行不参与修改点。
   */
  changeStart?: boolean;
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

    const hunkIdx = hunks.length - 1;
    if (raw.startsWith("-")) {
      current.rows.push({ type: "del", text: raw.slice(1), leftLineNo, hunkIdx });
      leftLineNo += 1;
    } else if (raw.startsWith("+")) {
      current.rows.push({ type: "add", text: raw.slice(1), rightLineNo, hunkIdx });
      rightLineNo += 1;
    } else if (raw.startsWith(" ")) {
      current.rows.push({
        type: "context",
        text: raw.slice(1),
        leftLineNo,
        rightLineNo,
        hunkIdx,
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
  if (
    rawLines.some((line) => DEV_NULL_OLD.test(line) || line.startsWith("new file mode "))
  ) status = "added";
  else if (
    rawLines.some((line) => DEV_NULL_NEW.test(line) || line.startsWith("deleted file mode "))
  ) status = "deleted";

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
    // 这一段不属于任何 hunk（hunkIdx 留空），只作为上下文占位。
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

    let changeIdx = -1;
    let prevRowWasChange = false;
    for (const row of hunk.rows) {
      const isChangeRow = row.type !== "context";
      if (isChangeRow && !prevRowWasChange) changeIdx += 1;
      const changeStart = isChangeRow && !prevRowWasChange;
      prevRowWasChange = isChangeRow;
      const basePair: FullDiffPair = {
        ...(row.hunkIdx !== undefined ? { hunkIdx: row.hunkIdx } : {}),
        ...(isChangeRow ? { changeIdx } : {}),
        ...(changeStart ? { changeStart: true } : {}),
      };
      if (row.type === "context") {
        const text = currentLines[currentIdx] ?? "";
        currentIdx += 1;
        pairs.push({
          ...basePair,
          left: { lineNo: oldNo, type: "context", text },
          right: { lineNo: newNo, type: "context", text },
        });
        oldNo += 1;
        newNo += 1;
      } else if (row.type === "add") {
        const text = currentLines[currentIdx] ?? "";
        currentIdx += 1;
        pairs.push({ ...basePair, right: { lineNo: newNo, type: "add", text } });
        newNo += 1;
      } else {
        pairs.push({ ...basePair, left: { lineNo: oldNo, type: "del", text: row.text } });
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
 * 透传 hunkIdx/changeIdx/changeStart 字段，确保审核视图能正确显示「撤销此段修改」按钮。
 */
export function linesToPairs(lines: ReviewSplitLine[]): FullDiffPair[] {
  const result: FullDiffPair[] = [];
  let changeIdx = -1;
  let prevRowWasChange = false;
  let prevHunkIdx: number | undefined;
  lines.forEach((line) => {
    const { hunkIdx } = line;
    if (hunkIdx !== prevHunkIdx) {
      changeIdx = -1;
      prevRowWasChange = false;
      prevHunkIdx = hunkIdx;
    }
    const isChangeRow = line.type !== "context";
    if (isChangeRow && !prevRowWasChange) changeIdx += 1;
    const changeStart = isChangeRow && !prevRowWasChange;
    prevRowWasChange = isChangeRow;
    const basePair: FullDiffPair =
      hunkIdx !== undefined || isChangeRow
        ? {
            ...(hunkIdx !== undefined ? { hunkIdx } : {}),
            ...(isChangeRow ? { changeIdx } : {}),
            ...(changeStart ? { changeStart: true } : {}),
          }
        : {};
    if (line.type === "del") {
      result.push({
        ...basePair,
        left: { lineNo: line.leftLineNo ?? 0, type: "del", text: line.text },
      });
      return;
    }
    if (line.type === "add") {
      result.push({
        ...basePair,
        right: { lineNo: line.rightLineNo ?? 0, type: "add", text: line.text },
      });
      return;
    }
    result.push({
      ...basePair,
      left: { lineNo: line.leftLineNo ?? 0, type: "context", text: line.text },
      right: { lineNo: line.rightLineNo ?? 0, type: "context", text: line.text },
    });
  });
  return result;
}

interface ReviewFileAccumulator {
  file: string;
  patches: string[];
  additions: number;
  deletions: number;
  status: ReviewFileStatus;
  statusExplicit: boolean;
}

/**
 * 将补丁切分为「文件头 + 各 hunk 原始行」。
 * hunk 起始判定与 parsePatchHunks 保持一致（HUNK_HEADER 正则），保证两边 hunk 数量一致。
 */
function splitPatchIntoHeaderAndHunks(patch: string): { header: string[]; hunks: string[][] } {
  const header: string[] = [];
  const hunks: string[][] = [];
  let currentHunk: string[] | null = null;

  for (const line of patch.split("\n")) {
    if (HUNK_HEADER.test(line)) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = [line];
    } else if (currentHunk) {
      currentHunk.push(line);
    } else {
      header.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return { header, hunks };
}

/**
 * 从完整补丁中提取指定 hunk 的独立补丁文本。
 * 保留文件头（diff --git / index / --- / +++ 等）+ 指定 hunk 的原始内容行，
 * 使其可作为独立的 git patch 传递给 `git apply --reverse`。
 */
export function extractHunkPatch(patch: string, hunkIndex: number): string | null {
  if (!patch || !patch.trim()) return null;
  const { header, hunks } = splitPatchIntoHeaderAndHunks(patch);
  if (hunkIndex < 0 || hunkIndex >= hunks.length) return null;
  return [...header, ...hunks[hunkIndex]].join("\n");
}

/**
 * 从指定 hunk 中提取单个「修改点」（连续增删块，上下文行分隔）的独立补丁文本。
 * git 会把间距小于上下文窗口的多处修改合并成一个 hunk；局部撤销若以 hunk 为
 * 粒度，用户想撤销其中一处就会被迫整段回退。这里在 hunk 内部再按上下文行切分
 * 修改点，只保留目标修改点前后各 3 行上下文，重建 hunk 头使 git apply 可以
 * 精确定位。原始行（含行尾 \r 与 `\ No newline at end of file` 标记）原样保留。
 */
export function extractChangePatch(
  patch: string,
  hunkIndex: number,
  changeIndex: number,
): string | null {
  if (!patch || !patch.trim()) return null;
  const { header, hunks } = splitPatchIntoHeaderAndHunks(patch);
  if (hunkIndex < 0 || hunkIndex >= hunks.length) return null;
  const hunkLines = hunks[hunkIndex];
  const hunkHeader = HUNK_HEADER.exec(hunkLines[0] || "");
  if (!hunkHeader) return null;
  const hunkOldStart = Number(hunkHeader[1]);
  const hunkNewStart = Number(hunkHeader[3]);

  // 解析 hunk 正文为行记录；`\ No newline` 标记归属前一内容行，原样随行携带。
  const rows: Array<{ kind: "ctx" | "del" | "add"; raw: string[] }> = [];
  for (const line of hunkLines.slice(1)) {
    if (line.startsWith("\\")) {
      rows[rows.length - 1]?.raw.push(line);
      continue;
    }
    const kind = line.startsWith("+")
      ? "add" as const
      : line.startsWith("-")
        ? "del" as const
        : line.startsWith(" ")
          ? "ctx" as const
          : null;
    if (!kind) continue;
    rows.push({ kind, raw: [line] });
  }

  // 定位修改点：连续的非上下文行为同一修改点。
  const blocks: Array<{ start: number; end: number }> = [];
  let currentStart = -1;
  rows.forEach((row, index) => {
    if (row.kind === "ctx") {
      currentStart = -1;
      return;
    }
    if (currentStart < 0) {
      currentStart = index;
      blocks.push({ start: index, end: index + 1 });
      return;
    }
    blocks[blocks.length - 1].end = index + 1;
  });
  if (changeIndex < 0 || changeIndex >= blocks.length) return null;

  const block = blocks[changeIndex];
  const start = Math.max(0, block.start - 3);
  const end = Math.min(rows.length, block.end + 3);
  const selected = rows.slice(start, end);
  if (selected.length === 0) return null;

  const leading = rows.slice(0, start);
  const oldOffset = leading.filter((row) => row.kind !== "add").length;
  const newOffset = leading.filter((row) => row.kind !== "del").length;
  const oldCount = selected.filter((row) => row.kind !== "add").length;
  const newCount = selected.filter((row) => row.kind !== "del").length;
  const newHeader = `@@ -${hunkOldStart + oldOffset},${oldCount} +${hunkNewStart + newOffset},${newCount} @@`;
  return [...header, newHeader, ...selected.flatMap((row) => row.raw)].join("\n");
}

/**
 * 重建式撤销的核心纯函数：从补丁日志中剔除被撤销的 hunk，返回需要重放的补丁序列。
 * revertedHunkIndexes 使用「合并序号」——即各补丁 hunk 顺序拼接后的全局下标，
 * 与审核视图的 hunk 序号一致（splitHunkIndex 同一套计数规则）。
 * 某份补丁的所有 hunk 都被撤销时，该补丁整体移除；未被撤销的补丁原样保留。
 */
export function dropPatchesHunks(
  patches: string[],
  revertedHunkIndexes: readonly number[],
): string[] {
  const reverted = new Set(revertedHunkIndexes);
  const result: string[] = [];
  let offset = 0;

  for (const patch of patches) {
    if (typeof patch !== "string" || !patch.trim()) continue;
    const { header, hunks } = splitPatchIntoHeaderAndHunks(patch);
    // 无 hunk 的补丁（空 / 仅元数据）没有可重放的内容，直接剔除。
    if (hunks.length === 0) continue;

    const keepHunks: string[][] = [];
    let droppedAny = false;
    for (let index = 0; index < hunks.length; index += 1) {
      if (reverted.has(offset + index)) {
        droppedAny = true;
      } else {
        keepHunks.push(hunks[index]);
      }
    }

    if (!droppedAny) result.push(patch);
    else if (keepHunks.length > 0) result.push([...header, ...keepHunks.flat()].join("\n"));
    offset += hunks.length;
  }

  return result;
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

const toFileKey = (file: string, projectPath?: string) => {
  const normalized = normalizeDiffPath(file);
  const windowsPath = /^[a-z]:\//i.test(normalized)
    || (typeof projectPath === "string" && /^[a-z]:[\\/]/i.test(projectPath));
  return windowsPath ? normalized.toLowerCase() : normalized;
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
    const key = toFileKey(diff.file, projectPath);
    let entry = byFile.get(key);
    if (!entry) {
      entry = {
        file: diff.file,
        patches: [],
        additions: 0,
        deletions: 0,
        status: "modified",
        statusExplicit: false,
      };
      byFile.set(key, entry);
    }
    const status = REVIEW_STATUS_KEYS[diff.status || ""];
    const statusExplicit = diff.statusExplicit === true;
    if (status) {
      const preservesLifecycle = entry.statusExplicit && status === "modified";
      if (!preservesLifecycle && (statusExplicit || !entry.statusExplicit)) entry.status = status;
      entry.statusExplicit = entry.statusExplicit || statusExplicit;
    }
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
    const { lines, status: inferredStatus } = splitPatch(patch);
    const status = entry.statusExplicit ? entry.status : inferredStatus;
    const hasPatch = patch.trim().length > 0;
    const additions = hasPatch
      ? lines.reduce((sum, line) => sum + (line.type === "add" ? 1 : 0), 0)
      : entry.additions;
    const deletions = hasPatch
      ? lines.reduce((sum, line) => sum + (line.type === "del" ? 1 : 0), 0)
      : entry.deletions;
    const hasUnsupportedMetadata = /^(?:diff --git|GIT binary patch|Binary files|old mode|new mode|rename from|rename to|copy from|copy to)\b/m.test(patch);
    // 没有任何增删的普通文件对审核没有意义；带文件级元数据的补丁仍保留，
    // 由主进程显示为何不能安全撤销。空文件的新建/删除也依赖这一分支。
    if (
      additions === 0
      && deletions === 0
      && entry.status !== "added"
      && entry.status !== "deleted"
      && !hasUnsupportedMetadata
    ) continue;
    result.push({
      file: entry.file,
      displayFile: toProjectRelativePath(entry.file, projectPath),
      status: hasPatch ? status : entry.status,
      statusExplicit: entry.statusExplicit,
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
