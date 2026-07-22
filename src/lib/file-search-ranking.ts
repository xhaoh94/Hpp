export type FileSearchMatchKind = "exact" | "substring" | "fuzzy";

export interface FileSearchMatch {
  kind: FileSearchMatchKind;
  start: number;
  span: number;
  gapCount: number;
  indices: number[];
}

export interface FileSearchRankableItem {
  name: string;
  path: string;
  isDirectory: boolean;
  normalizedName?: string;
  normalizedPath?: string;
}

type FileSearchMatchScore = Omit<FileSearchMatch, "indices">;

const MATCH_KIND_RANK: Record<FileSearchMatchKind, number> = {
  exact: 0,
  substring: 1,
  fuzzy: 2,
};

const normalizedItemCache = new WeakMap<
  FileSearchRankableItem,
  { name: string; path?: string }
>();

function getNormalizedItemName(item: FileSearchRankableItem) {
  if (item.normalizedName !== undefined) return item.normalizedName;
  const cached = normalizedItemCache.get(item);
  if (cached) return cached.name;
  const name = item.name.toLowerCase();
  normalizedItemCache.set(item, { name });
  return name;
}

function getNormalizedItemPath(item: FileSearchRankableItem) {
  if (item.normalizedPath !== undefined) return item.normalizedPath;
  const cached = normalizedItemCache.get(item);
  if (cached?.path !== undefined) return cached.path;
  const path = item.path.toLowerCase();
  normalizedItemCache.set(item, { name: cached?.name ?? item.name.toLowerCase(), path });
  return path;
}

function getNormalizedFileSearchMatch(
  normalizedText: string,
  normalizedQuery: string,
): FileSearchMatchScore | null {
  if (normalizedText === normalizedQuery) {
    return {
      kind: "exact",
      start: 0,
      span: normalizedQuery.length,
      gapCount: 0,
    };
  }

  const substringStart = normalizedText.indexOf(normalizedQuery);
  if (substringStart >= 0) {
    return {
      kind: "substring",
      start: substringStart,
      span: normalizedQuery.length,
      gapCount: 0,
    };
  }

  const subsequenceStarts = Array<number>(normalizedQuery.length).fill(-1);
  let start = -1;
  let end = -1;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (let textIndex = 0; textIndex < normalizedText.length; textIndex += 1) {
    let completed = false;
    for (let queryIndex = normalizedQuery.length - 1; queryIndex >= 0; queryIndex -= 1) {
      if (normalizedText[textIndex] !== normalizedQuery[queryIndex]) continue;
      if (queryIndex === 0) {
        subsequenceStarts[0] = textIndex;
      } else if (subsequenceStarts[queryIndex - 1] >= 0) {
        subsequenceStarts[queryIndex] = subsequenceStarts[queryIndex - 1];
        if (queryIndex === normalizedQuery.length - 1) completed = true;
      }
    }
    if (!completed) continue;

    const candidateStart = subsequenceStarts[normalizedQuery.length - 1];
    const candidateSpan = textIndex - candidateStart + 1;
    if (candidateSpan < bestSpan || (candidateSpan === bestSpan && candidateStart < start)) {
      start = candidateStart;
      end = textIndex;
      bestSpan = candidateSpan;
    }
  }
  if (start < 0) return null;

  const span = end - start + 1;
  return {
    kind: "fuzzy",
    start,
    span,
    gapCount: span - normalizedQuery.length,
  };
}

export function getFileSearchMatch(text: string, query: string): FileSearchMatch | null {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;

  const score = getNormalizedFileSearchMatch(normalizedText, normalizedQuery);
  if (!score) return null;

  if (score.kind !== "fuzzy") {
    return {
      ...score,
      indices: Array.from(
        { length: normalizedQuery.length },
        (_, index) => score.start + index,
      ),
    };
  }

  const indices: number[] = [];
  let queryIndex = 0;
  const matchEnd = score.start + score.span;
  for (let textIndex = score.start; textIndex < matchEnd && queryIndex < normalizedQuery.length; textIndex += 1) {
    if (normalizedText[textIndex] !== normalizedQuery[queryIndex]) continue;
    indices.push(textIndex);
    queryIndex += 1;
  }
  return { ...score, indices };
}

function compareMatches(left: FileSearchMatchScore, right: FileSearchMatchScore): number {
  const kindDifference = MATCH_KIND_RANK[left.kind] - MATCH_KIND_RANK[right.kind];
  if (kindDifference !== 0) return kindDifference;

  if (left.kind === "substring" && right.kind === "substring") {
    return left.start - right.start;
  }

  if (left.kind === "fuzzy" && right.kind === "fuzzy") {
    return left.gapCount - right.gapCount
      || left.span - right.span
      || left.start - right.start;
  }

  return 0;
}

function compareNormalizedText(normalizedLeft: string, normalizedRight: string): number {
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

interface RankedFileSearchEntry<T extends FileSearchRankableItem> {
  item: T;
  match: FileSearchMatchScore;
  normalizedName: string;
  normalizedPath: string;
  originalIndex: number;
  pathDepth: number;
}

function getFileSearchPathDepth(path: string) {
  let depth = 0;
  for (const character of path) {
    if (character === "/" || character === "\\") depth += 1;
  }
  return depth;
}

function compareRankedEntries<T extends FileSearchRankableItem>(
  left: RankedFileSearchEntry<T>,
  right: RankedFileSearchEntry<T>,
) {
  return compareMatches(left.match, right.match)
    || left.item.name.length - right.item.name.length
    || (left.item.isDirectory === right.item.isDirectory ? 0 : left.item.isDirectory ? -1 : 1)
    || compareNormalizedText(left.normalizedName, right.normalizedName)
    || left.pathDepth - right.pathDepth
    || compareNormalizedText(left.normalizedPath, right.normalizedPath)
    || left.originalIndex - right.originalIndex;
}

function pushTopRankedEntry<T extends FileSearchRankableItem>(
  heap: RankedFileSearchEntry<T>[],
  entry: RankedFileSearchEntry<T>,
  limit: number,
) {
  if (heap.length < limit) {
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareRankedEntries(heap[parent], heap[index]) >= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }

  if (compareRankedEntries(entry, heap[0]) >= 0) return;
  heap[0] = entry;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compareRankedEntries(heap[left], heap[worst]) > 0) worst = left;
    if (right < heap.length && compareRankedEntries(heap[right], heap[worst]) > 0) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

function normalizeRankingLimit(limit?: number): number | null {
  return limit === undefined || !Number.isFinite(limit)
    ? null
    : Math.max(0, Math.floor(limit));
}

function addRankedItem<T extends FileSearchRankableItem>(
  rankedEntries: RankedFileSearchEntry<T>[],
  item: T,
  originalIndex: number,
  normalizedQuery: string,
  boundedLimit: number | null,
) {
  const normalizedName = getNormalizedItemName(item);
  const match = getNormalizedFileSearchMatch(normalizedName, normalizedQuery);
  if (!match) return;

  const entry: RankedFileSearchEntry<T> = {
    item,
    match,
    normalizedName,
    normalizedPath: getNormalizedItemPath(item),
    originalIndex,
    pathDepth: getFileSearchPathDepth(item.path),
  };
  if (boundedLimit === null) rankedEntries.push(entry);
  else pushTopRankedEntry(rankedEntries, entry, boundedLimit);
}

function finalizeRankedItems<T extends FileSearchRankableItem>(
  rankedEntries: RankedFileSearchEntry<T>[],
) {
  return rankedEntries
    .sort(compareRankedEntries)
    .map((entry) => entry.item);
}

export function rankFileSearchItems<T extends FileSearchRankableItem>(
  items: readonly T[],
  query: string,
  limit?: number,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const boundedLimit = normalizeRankingLimit(limit);
  if (boundedLimit === 0) return [];

  const rankedEntries: RankedFileSearchEntry<T>[] = [];
  items.forEach((item, originalIndex) => {
    addRankedItem(rankedEntries, item, originalIndex, normalizedQuery, boundedLimit);
  });

  return finalizeRankedItems(rankedEntries);
}

export interface AsyncFileSearchRankingOptions {
  signal?: AbortSignal;
  yieldEvery?: number;
}

export async function rankFileSearchItemsAsync<T extends FileSearchRankableItem>(
  items: readonly T[],
  query: string,
  limit?: number,
  options: AsyncFileSearchRankingOptions = {},
): Promise<T[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || options.signal?.aborted) return [];

  const boundedLimit = normalizeRankingLimit(limit);
  if (boundedLimit === 0) return [];
  const requestedYieldEvery = options.yieldEvery ?? 20_000;
  const yieldEvery = Number.isFinite(requestedYieldEvery)
    ? Math.max(1, Math.floor(requestedYieldEvery))
    : 20_000;
  const rankedEntries: RankedFileSearchEntry<T>[] = [];

  for (let index = 0; index < items.length; index += 1) {
    addRankedItem(rankedEntries, items[index], index, normalizedQuery, boundedLimit);
    if ((index + 1) % yieldEvery !== 0 || index + 1 >= items.length) continue;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (options.signal?.aborted) return [];
  }

  if (options.signal?.aborted) return [];
  return finalizeRankedItems(rankedEntries);
}
