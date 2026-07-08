import type { AgentProcessEntry, AgentProcessFile } from "@/stores/chat-store";
import { getProcessFileEntryTitle } from "@/i18n/text";

type MergeState = {
  mergedEntries: AgentProcessEntry[];
  mergedIndexBySourceIndex: number[];
  sourceEntries: AgentProcessEntry[];
};

const EMPTY_PROCESS_FILES: AgentProcessFile[] = [];
const mergedProcessFilesCache = new WeakMap<AgentProcessFile[], AgentProcessFile[]>();

export const getProcessFileName = (filePath: string) => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

const normalizeProcessFileKey = (filePath: string) =>
  filePath.replace(/\\/g, "/").trim().toLowerCase();

const mergeProcessFileCounts = (left?: number, right?: number) => {
  if (typeof left !== "number" && typeof right !== "number") return undefined;
  return (left || 0) + (right || 0);
};

export const mergeProcessFiles = (files: AgentProcessFile[]) => {
  if (files.length === 0) return EMPTY_PROCESS_FILES;

  const cached = mergedProcessFilesCache.get(files);
  if (cached) return cached;

  const byFile = new Map<string, AgentProcessFile>();

  for (const file of files) {
    if (!file.file?.trim()) continue;

    const key = normalizeProcessFileKey(file.file);
    const existing = byFile.get(key);
    if (!existing) {
      byFile.set(key, { ...file, label: file.label || getProcessFileName(file.file) });
      continue;
    }

    byFile.set(key, {
      ...existing,
      ...file,
      label: existing.label || file.label || getProcessFileName(file.file),
      additions: mergeProcessFileCounts(existing.additions, file.additions),
      deletions: mergeProcessFileCounts(existing.deletions, file.deletions),
    });
  }

  const merged = Array.from(byFile.values());
  mergedProcessFilesCache.set(files, merged);
  return merged;
};

const getEntryFiles = (entry: AgentProcessEntry) =>
  entry.files ? mergeProcessFiles(entry.files) : undefined;

const toolKindToAction = (toolKind: string): AgentProcessFile["action"] => {
  switch (toolKind) {
    case "read_file": return "read";
    case "list_dir": return "listed";
    case "write_file": return "written";
    case "edit_file": return "edited";
    default: return undefined;
  }
};

const canMergeSourceEntries = (
  left: AgentProcessEntry | undefined,
  right: AgentProcessEntry | undefined
) => {
  if (!left || !right) return false;
  if (left.type !== "tool" || right.type !== "tool") return false;
  if (!left.toolKind || left.toolKind !== right.toolKind) return false;
  if (left.state !== right.state) return false;
  return !!getEntryFiles(left)?.length && !!getEntryFiles(right)?.length;
};

const findMergeGroupStart = (entries: AgentProcessEntry[], index: number) => {
  let start = Math.max(0, Math.min(index, entries.length - 1));
  while (start > 0 && canMergeSourceEntries(entries[start - 1], entries[start])) {
    start -= 1;
  }
  return start;
};

const appendMergedEntry = (
  merged: AgentProcessEntry[],
  entry: AgentProcessEntry
) => {
  const last = merged[merged.length - 1];
  const entryFiles = getEntryFiles(entry);

  if (
    entry.type === "tool" && last?.type === "tool" &&
    entry.toolKind && last.toolKind === entry.toolKind &&
    entry.state === last.state &&
    last.files && last.files.length > 0 &&
    entryFiles && entryFiles.length > 0
  ) {
    const files = mergeProcessFiles([...last.files, ...entryFiles]);
    const action = toolKindToAction(entry.toolKind);
    merged[merged.length - 1] = {
      ...last,
      files,
      title: getProcessFileEntryTitle(action, files.length, entry.state === "running"),
      id: entry.id,
    };
    return;
  }

  merged.push({ ...entry, files: entryFiles });
};

const mergeProcessEntriesFrom = (
  entries: AgentProcessEntry[],
  startIndex: number,
  prefixEntries: AgentProcessEntry[],
  prefixIndexMap: number[]
): MergeState => {
  const mergedEntries = [...prefixEntries];
  const mergedIndexBySourceIndex = [...prefixIndexMap];

  for (let index = startIndex; index < entries.length; index += 1) {
    appendMergedEntry(mergedEntries, entries[index]);
    mergedIndexBySourceIndex[index] = mergedEntries.length - 1;
  }

  return {
    sourceEntries: entries,
    mergedEntries,
    mergedIndexBySourceIndex,
  };
};

export const mergeProcessEntries = (entries: AgentProcessEntry[]) =>
  mergeProcessEntriesFrom(entries, 0, [], []).mergedEntries;

export const createProcessEntryMerger = () => {
  let state: MergeState | null = null;

  return (entries: AgentProcessEntry[]) => {
    if (state?.sourceEntries === entries) return state.mergedEntries;
    if (entries.length === 0) {
      state = {
        sourceEntries: entries,
        mergedEntries: [],
        mergedIndexBySourceIndex: [],
      };
      return state.mergedEntries;
    }

    if (!state) {
      state = mergeProcessEntriesFrom(entries, 0, [], []);
      return state.mergedEntries;
    }

    let firstChangedIndex = 0;
    const maxCommonLength = Math.min(entries.length, state.sourceEntries.length);
    while (
      firstChangedIndex < maxCommonLength &&
      entries[firstChangedIndex] === state.sourceEntries[firstChangedIndex]
    ) {
      firstChangedIndex += 1;
    }

    if (firstChangedIndex === entries.length && entries.length === state.sourceEntries.length) {
      return state.mergedEntries;
    }

    const rebuildAnchorIndex = Math.min(firstChangedIndex, entries.length - 1);
    const rebuildStartIndex = findMergeGroupStart(entries, rebuildAnchorIndex);
    const prefixEndSourceIndex = rebuildStartIndex - 1;
    const prefixEndMergedIndex = prefixEndSourceIndex >= 0
      ? state.mergedIndexBySourceIndex[prefixEndSourceIndex]
      : -1;
    const prefixEntries = prefixEndMergedIndex >= 0
      ? state.mergedEntries.slice(0, prefixEndMergedIndex + 1)
      : [];
    const prefixIndexMap = prefixEndSourceIndex >= 0
      ? state.mergedIndexBySourceIndex.slice(0, prefixEndSourceIndex + 1)
      : [];

    state = mergeProcessEntriesFrom(entries, rebuildStartIndex, prefixEntries, prefixIndexMap);
    return state.mergedEntries;
  };
};
