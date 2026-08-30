export type DiffLike = {
  file: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string;
  statusExplicit?: boolean;
};

export type DiffFileSummary = {
  file: string;
  additions: number;
  deletions: number;
  patches: string[];
  /** 文件变更类型：added / deleted / modified。新建文件需据此在列表中保留。 */
  status?: string;
};

type DiffFileAccumulator = DiffFileSummary & {
  patchAdditions: number;
  patchDeletions: number;
  metaAdditions: number;
  metaDeletions: number;
  seenChanges: Set<string>;
  statusExplicit: boolean;
};

export const isReversiblePatch = (patch: string) => {
  const trimmed = patch.trim();
  return !!trimmed && (/^diff --git\s+/m.test(trimmed) || (/^---\s+/m.test(trimmed) && /^\+\+\+\s+/m.test(trimmed)));
};

export const normalizeDiffPath = (file: string) => file.replace(/\\/g, "/");

export const toProjectRelativePath = (file: string, projectPath?: string) => {
  const normalizedFile = normalizeDiffPath(file);
  const normalizedProject = projectPath ? normalizeDiffPath(projectPath).replace(/\/+$/, "") : "";
  if (!normalizedProject) return normalizedFile;
  const fileKey = normalizedFile.toLowerCase();
  const projectKey = normalizedProject.toLowerCase();
  if (fileKey === projectKey) return normalizedFile.split("/").pop() || normalizedFile;
  return fileKey.startsWith(`${projectKey}/`)
    ? normalizedFile.slice(normalizedProject.length + 1)
    : normalizedFile;
};

const countPatchChanges = (patch: string) => ({
  additions: (patch.match(/^\+[^+]/gm) || []).length,
  deletions: (patch.match(/^-[^-]/gm) || []).length,
});

export function buildDiffSummary(diffs: DiffLike[], projectPath?: string) {
  const byFile = new Map<string, DiffFileAccumulator>();
  const reversiblePatches: string[] = [];
  const seenReversiblePatches = new Set<string>();
  for (const diff of diffs) {
    const file = toProjectRelativePath(diff.file || "未命名文件", projectPath);
    const patch = typeof diff.patch === "string" ? diff.patch : "";
    const trimmedPatch = patch.trim();
    const countedPatch = trimmedPatch ? countPatchChanges(patch) : { additions: 0, deletions: 0 };
    if (isReversiblePatch(patch) && !seenReversiblePatches.has(patch)) {
      seenReversiblePatches.add(patch);
      reversiblePatches.push(patch);
    }
    const changeKey = trimmedPatch
      ? `patch:${patch}`
      : `meta:${diff.status || "modified"}:${diff.additions || 0}:${diff.deletions || 0}`;
    const existing = byFile.get(file) || {
      file,
      additions: 0,
      deletions: 0,
      patchAdditions: 0,
      patchDeletions: 0,
      metaAdditions: 0,
      metaDeletions: 0,
      patches: [],
      seenChanges: new Set<string>(),
      statusExplicit: false,
    };
    if (!existing.seenChanges.has(changeKey)) {
      existing.seenChanges.add(changeKey);
      if (trimmedPatch) {
        existing.patchAdditions += Math.max(0, diff.additions || countedPatch.additions || 0);
        existing.patchDeletions += Math.max(0, diff.deletions || countedPatch.deletions || 0);
        existing.patches.push(patch);
      } else {
        existing.metaAdditions = Math.max(existing.metaAdditions, Math.max(0, diff.additions || 0));
        existing.metaDeletions = Math.max(existing.metaDeletions, Math.max(0, diff.deletions || 0));
      }
    }
    const nextStatusExplicit = diff.statusExplicit === true;
    if (diff.status && !(existing.statusExplicit && !nextStatusExplicit)) {
      existing.status = diff.status;
    }
    if (nextStatusExplicit) existing.statusExplicit = true;
    byFile.set(file, existing);
  }
  const files = Array.from(byFile.values())
    .map(({ seenChanges: _seen, statusExplicit: _statusExplicit, patchAdditions, patchDeletions, metaAdditions, metaDeletions, ...file }) => ({
      ...file,
      additions: file.patches.length > 0 ? patchAdditions : metaAdditions,
      deletions: file.patches.length > 0 ? patchDeletions : metaDeletions,
    }))
    .filter(
      (file) =>
        file.patches.length > 0 ||
        file.additions > 0 ||
        file.deletions > 0 ||
        file.status === "added" ||
        file.status === "created" ||
        file.status === "deleted",
    )
    .sort((left, right) => left.file.localeCompare(right.file));
  return {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    patchCount: files.reduce((sum, file) => sum + file.patches.length, 0),
    // 保留 diff 的产生顺序；IPC 会按逆序逐份反向应用，支持同一文件多次修改。
    reversiblePatches,
  };
}

export type ProcessFileDiff = DiffLike & { action?: string; changeKey?: string };
export type ProcessDiffEntry = { id: string; files?: ProcessFileDiff[] };
const DIFF_ACTIONS = new Set(["edited", "modified", "written"]);

export function collectProcessDiffs(process?: { entries?: ProcessDiffEntry[] }): DiffLike[] {
  if (!process?.entries?.length) return [];
  const byFile = new Map<string, DiffLike & { seenKeys: Set<string> }>();
  const patchDiffs: DiffLike[] = [];
  const seenPatchKeys = new Set<string>();
  for (const entry of process.entries) {
    entry.files?.forEach((file, index) => {
      const patch = typeof file.patch === "string" ? file.patch : "";
      const fileAction = (file.action || "").toLowerCase();
      const hasPatch = patch.trim().length > 0;
      const hasCounts = (file.additions || 0) > 0 || (file.deletions || 0) > 0;
      // 只有补丁、变更计数、生命周期状态或明确的变更动作才是文件
      // 变更。读文件以及被 Diff 通道剥离 payload 后仅剩路径的工具条目
      // 不能被误渲染成一个空的 modified 文件。
      const isChangeAction = DIFF_ACTIONS.has(fileAction)
        || ["created", "new", "added", "deleted"].includes(fileAction);
      const hasLifecycleStatus = !!file.status || file.statusExplicit === true;
      if (!file.file || (!hasPatch && !hasCounts && !isChangeAction && !hasLifecycleStatus)) return;
      const derivedStatus = file.status || (fileAction === "created" || fileAction === "new" || fileAction === "added" ? "added" : fileAction === "deleted" ? "deleted" : "modified");
      const key = String(file.changeKey || `${entry.id}:${file.file}:${index}`);
      if (patch.trim()) {
        if (seenPatchKeys.has(key)) return;
        seenPatchKeys.add(key);
        patchDiffs.push({
          file: file.file,
          patch,
          additions: Math.max(0, file.additions || 0),
          deletions: Math.max(0, file.deletions || 0),
          status: derivedStatus,
          ...(file.statusExplicit === true ? { statusExplicit: true } : {}),
        });
        return;
      }
      const existing = byFile.get(file.file) || {
        file: file.file,
        patch: "",
        additions: 0,
        deletions: 0,
        status: derivedStatus,
        ...(file.statusExplicit === true ? { statusExplicit: true } : {}),
        seenKeys: new Set<string>(),
      };
      if (existing.seenKeys.has(key)) return;
      existing.seenKeys.add(key);
      existing.additions = (existing.additions || 0) + Math.max(0, file.additions || 0);
      existing.deletions = (existing.deletions || 0) + Math.max(0, file.deletions || 0);
      const nextExplicit = file.statusExplicit === true;
      if (!(existing.statusExplicit === true && !nextExplicit)) {
        existing.status = file.status || existing.status;
      }
      if (nextExplicit) existing.statusExplicit = true;
      byFile.set(file.file, existing);
    });
  }
  return [...patchDiffs, ...Array.from(byFile.values()).map(({ seenKeys: _seen, ...diff }) => diff)];
}
