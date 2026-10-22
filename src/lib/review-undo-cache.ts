import type {
  PrepareReviewUndoRequest,
  ReviewUndoLoadResult,
  ReviewUndoState,
} from "@shared/review-undo";

/**
 * DiffBlock 的撤销状态缓存。聊天列表是虚拟化的：滚动历史时每个 diff 卡片
 * 会反复挂载/卸载，而 loadReviewUndo 每次都要把全量 patch 发给主进程、读回
 * 每个文件的当前内容并重算 diff。按 reviewId + patch 指纹缓存后，重复挂载
 * 不再触发 IPC 与主进程计算。
 */

const REVIEW_UNDO_CACHE_TTL_MS = 120_000;
const REVIEW_UNDO_CACHE_MAX_ENTRIES = 256;

type CacheEntry = {
  state: ReviewUndoState | null;
  loadedAt: number;
};

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ReviewUndoState | null>>();
// 作废时递增 epoch：在途请求回来时若 epoch 已变，说明结果已过期，不得写回缓存。
const epochs = new Map<string, number>();

const buildCacheKey = (request: PrepareReviewUndoRequest): string => (
  `${request.projectPath}\u0000${request.reviewId}\u0000${JSON.stringify(request.files)}`
);

export function getCachedReviewUndoState(
  key: string,
  now = Date.now(),
): ReviewUndoState | null | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now - entry.loadedAt > REVIEW_UNDO_CACHE_TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return entry.state;
}

const storeCachedReviewUndoState = (key: string, state: ReviewUndoState | null) => {
  entries.set(key, { state, loadedAt: Date.now() });
  while (entries.size > REVIEW_UNDO_CACHE_MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
};

/**
 * 撤销动作改写了磁盘文件，之后 load 的结果会变。 dialog 每次 undo 后调用，
 * 丢弃该 review 已缓存和在途的状态，让下一个 DiffBlock 挂载重新拉取。
 */
export function invalidateReviewUndoCache(reviewId: string, projectPath?: string): void {
  const prefix = `${projectPath ?? ""}\u0000${reviewId}\u0000`;
  const keys = new Set<string>([...entries.keys(), ...inFlight.keys()]);
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    entries.delete(key);
    inFlight.delete(key);
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
  }
}

export function loadReviewUndoState(
  request: PrepareReviewUndoRequest,
): Promise<ReviewUndoState | null> {
  const key = buildCacheKey(request);
  const cached = getCachedReviewUndoState(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const epoch = epochs.get(key) ?? 0;
  const promise = window.electronAPI.loadReviewUndo(request)
    .then((result: ReviewUndoLoadResult) => {
      // 准备失败不缓存：保持「下次挂载重试」的原有行为。
      // success 且 state 为 null 是「该 review 从未 prepare」的合法答案，要缓存。
      if (!result.success) return null;
      if ((epochs.get(key) ?? 0) === epoch) storeCachedReviewUndoState(key, result.state ?? null);
      return result.state ?? null;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}
