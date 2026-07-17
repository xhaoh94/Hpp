export type DiffLike = {
  file: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string;
};

export type DiffFileSummary = {
  file: string;
  additions: number;
  deletions: number;
  patches: string[];
};

type DiffFileAccumulator = DiffFileSummary & {
  patchAdditions: number;
  patchDeletions: number;
  metaAdditions: number;
  metaDeletions: number;
  seenChanges: Set<string>;
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
  for (const diff of diffs) {
    const file = toProjectRelativePath(diff.file || "未命名文件", projectPath);
    const patch = typeof diff.patch === "string" ? diff.patch : "";
    const trimmedPatch = patch.trim();
    const countedPatch = trimmedPatch ? countPatchChanges(patch) : { additions: 0, deletions: 0 };
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
    byFile.set(file, existing);
  }
  const files = Array.from(byFile.values())
    .map(({ seenChanges: _seen, patchAdditions, patchDeletions, metaAdditions, metaDeletions, ...file }) => ({
      ...file,
      additions: file.patches.length > 0 ? patchAdditions : metaAdditions,
      deletions: file.patches.length > 0 ? patchDeletions : metaDeletions,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  return {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    patchCount: files.reduce((sum, file) => sum + file.patches.length, 0),
    reversiblePatches: files.flatMap((file) => file.patches).filter(isReversiblePatch),
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
      if (!file.file || (!DIFF_ACTIONS.has(file.action || "") && !patch.trim())) return;
      const key = String(file.changeKey || `${entry.id}:${file.file}:${index}`);
      if (patch.trim()) {
        if (seenPatchKeys.has(key)) return;
        seenPatchKeys.add(key);
        patchDiffs.push({
          file: file.file,
          patch,
          additions: Math.max(0, file.additions || 0),
          deletions: Math.max(0, file.deletions || 0),
          status: file.status || "modified",
        });
        return;
      }
      const existing = byFile.get(file.file) || {
        file: file.file,
        patch: "",
        additions: 0,
        deletions: 0,
        status: file.status || "modified",
        seenKeys: new Set<string>(),
      };
      if (existing.seenKeys.has(key)) return;
      existing.seenKeys.add(key);
      existing.additions = (existing.additions || 0) + Math.max(0, file.additions || 0);
      existing.deletions = (existing.deletions || 0) + Math.max(0, file.deletions || 0);
      existing.status = file.status || existing.status;
      byFile.set(file.file, existing);
    });
  }
  return [...patchDiffs, ...Array.from(byFile.values()).map(({ seenKeys: _seen, ...diff }) => diff)];
}
