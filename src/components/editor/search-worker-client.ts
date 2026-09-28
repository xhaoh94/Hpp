/**
 * 搜索 Worker 主线程桥接：单例 Worker + Promise pending map。
 *
 * 主线程把"一批文件内容 + 搜索参数"发给 Worker，Worker 在后台线程执行
 * 正则匹配并返回结果。文件读取仍在主线程（异步 IPC 不阻塞），
 * CPU 密集的 findTextMatches 全部交给 Worker。
 */
import type { SearchWorkerFile, SearchWorkerRequest, SearchWorkerResponse, SearchWorkerResult } from "./search-worker";

let worker: Worker | null = null;
let nextRequestId = 1;

type PendingSearch = {
  resolve: (results: SearchWorkerResult[]) => void;
  reject: (error: Error) => void;
  cleanupAbort?: () => void;
};

const pending = new Map<number, PendingSearch>();

const createAbortError = () => {
  const error = new Error("搜索已取消");
  error.name = "AbortError";
  return error;
};

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
      const msg = event.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      entry.cleanupAbort?.();
      if (msg.ok) entry.resolve(msg.results ?? []);
      else entry.reject(new Error(msg.error ?? "search worker failed"));
    };
    worker.onerror = (event) => {
      for (const [, entry] of pending) {
        entry.reject(new Error(event.message || "search worker error"));
      }
      pending.clear();
    };
  }
  return worker;
}

/**
 * 在 Worker 中对一批文件执行搜索。
 * Worker 不可用时（如构建异常）会 reject，调用方可回退主线程执行。
 */
export function searchFilesInWorker(
  files: SearchWorkerFile[],
  query: string,
  options: { matchCase: boolean; wholeWord: boolean; regex: boolean },
  maxMatchesPerFile = 200,
  signal?: AbortSignal,
): Promise<SearchWorkerResult[]> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let cleanupAbort: () => void = () => undefined;
    const entry: PendingSearch = {
      resolve: (results) => {
        cleanupAbort();
        resolve(results);
      },
      reject: (error) => {
        cleanupAbort();
        reject(error);
      },
      cleanupAbort: () => cleanupAbort(),
    };
    pending.set(id, entry);

    if (signal) {
      const onAbort = () => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        cleanupAbort();
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => signal.removeEventListener("abort", onAbort);
    }

    const request: SearchWorkerRequest = {
      id,
      type: "search",
      files,
      query,
      matchCase: options.matchCase,
      wholeWord: options.wholeWord,
      regex: options.regex,
      maxMatchesPerFile,
    };
    getWorker().postMessage(request);
  });
}
