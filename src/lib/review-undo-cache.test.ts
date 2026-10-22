import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewUndoState } from "@shared/review-undo";
import {
  getCachedReviewUndoState,
  invalidateReviewUndoCache,
  loadReviewUndoState,
} from "./review-undo-cache";

const state = (transactionId: string): ReviewUndoState => ({
  transactionId,
  version: 1,
  files: [{ file: "src/main.ts", status: "modified", patch: "@@", additions: 1, deletions: 1, hunkCount: 1, undoable: true, reverted: false }],
  canUndoAll: true,
  allReverted: false,
});

const request = (reviewId: string) => ({
  reviewId,
  projectPath: "C:\\work\\app",
  files: [{ file: "src/main.ts", patches: ["@@"], status: "modified" }],
});

let loadCalls: unknown[] = [];
let loadHandler: ((request: unknown) => Promise<{ success: boolean; state?: ReviewUndoState | null; error?: string }>) | null = null;

const stubElectronAPI = (
  handler: (request: unknown) => Promise<{ success: boolean; state?: ReviewUndoState | null; error?: string }>,
) => {
  loadCalls = [];
  loadHandler = handler;
  vi.stubGlobal("window", {
    electronAPI: {
      loadReviewUndo: (payload: unknown) => {
        loadCalls.push(payload);
        return handler(payload);
      },
    },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  loadHandler = null;
});

describe("review undo state cache", () => {
  it("issues one IPC per review and serves later mounts from cache", async () => {
    stubElectronAPI(async () => ({ success: true, state: state("txn-1") }));

    const first = await loadReviewUndoState(request("review-1"));
    const second = await loadReviewUndoState(request("review-1"));

    expect(first?.transactionId).toBe("txn-1");
    expect(second).toBe(first);
    expect(loadCalls).toHaveLength(1);
  });

  it("caches the null state of a review that was never prepared", async () => {
    stubElectronAPI(async () => ({ success: true, state: null }));

    expect(await loadReviewUndoState(request("review-null"))).toBeNull();
    expect(await loadReviewUndoState(request("review-null"))).toBeNull();
    expect(loadCalls).toHaveLength(1);
  });

  it("does not cache failures so a later mount can retry", async () => {
    stubElectronAPI(async () => ({ success: false, error: "boom" }));

    expect(await loadReviewUndoState(request("review-fail"))).toBeNull();
    expect(await loadReviewUndoState(request("review-fail"))).toBeNull();
    expect(loadCalls).toHaveLength(2);
  });

  it("deduplicates concurrent loads of the same review", async () => {
    let resolveLoad: ((value: { success: boolean; state: ReviewUndoState }) => void) | null = null;
    stubElectronAPI(() => new Promise((resolve) => { resolveLoad = resolve; }));

    const first = loadReviewUndoState(request("review-2"));
    const second = loadReviewUndoState(request("review-2"));
    resolveLoad!({ success: true, state: state("txn-2") });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(loadCalls).toHaveLength(1);
  });

  it("drops entries once the TTL elapsed", async () => {
    stubElectronAPI(async () => ({ success: true, state: state("txn-3") }));
    const payload = request("review-3");
    await loadReviewUndoState(payload);

    const key = `C:\\work\\app\u0000review-3\u0000${JSON.stringify(payload.files)}`;
    expect(getCachedReviewUndoState(key, Date.now())).not.toBeUndefined();
    expect(getCachedReviewUndoState(key, Date.now() + 120_001)).toBeUndefined();

    await loadReviewUndoState(payload);
    expect(loadCalls).toHaveLength(2);
  });

  it("invalidates cached and in-flight state after an undo", async () => {
    stubElectronAPI(async () => ({ success: true, state: state("txn-4") }));
    const payload = request("review-4");
    await loadReviewUndoState(payload);

    invalidateReviewUndoCache("review-4", "C:\\work\\app");

    // 缓存条目被丢弃：下一次挂载重新 IPC。
    await loadReviewUndoState(payload);
    expect(loadCalls).toHaveLength(2);
  });

  it("never writes back an in-flight result that an undo invalidated mid-flight", async () => {
    let resolveLoad: ((value: { success: boolean; state: ReviewUndoState }) => void) | null = null;
    let call = 0;
    stubElectronAPI(() => {
      call += 1;
      if (call === 1) return new Promise((resolve) => { resolveLoad = resolve; });
      return Promise.resolve({ success: true, state: state("txn-5b") });
    });

    const payload = request("review-5");
    const pending = loadReviewUndoState(payload);
    invalidateReviewUndoCache("review-5", "C:\\work\\app");
    resolveLoad!({ success: true, state: state("txn-5") });
    await pending;

    // 在途结果已过期：不得写回缓存，后续加载必须重新 IPC。
    const refreshed = await loadReviewUndoState(payload);
    expect(refreshed?.transactionId).toBe("txn-5b");
    expect(loadCalls).toHaveLength(2);
  });

  it("only invalidates the targeted review", async () => {
    stubElectronAPI(async () => ({ success: true, state: state("txn-6") }));
    const target = request("review-6");
    const other = request("review-7");
    await loadReviewUndoState(target);
    await loadReviewUndoState(other);

    invalidateReviewUndoCache("review-6", "C:\\work\\app");

    await loadReviewUndoState(other);
    expect(loadCalls).toHaveLength(2);
    await loadReviewUndoState(target);
    expect(loadCalls).toHaveLength(3);
  });
});
