/**
 * 项目级搜索 Worker：在后台线程执行 findTextMatches，避免正则匹配阻塞主线程。
 *
 * 输入：一批文件（path + content）+ 搜索参数。
 * 输出：该批文件的匹配结果（带行级预览与列范围）。
 *
 * 主线程仍负责文件读取（异步 IPC，本身不阻塞），Worker 只承担 CPU 密集的
 * 正则遍历部分。
 */
import { findTextMatches } from "@/lib/text-search";

export interface SearchWorkerFile {
  path: string;
  name: string;
  relPath: string;
  dirPath: string;
  content: string;
}

export interface SearchWorkerResult {
  path: string;
  name: string;
  relPath: string;
  dirPath: string;
  lineNumber: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchWorkerRequest {
  id: number;
  type: "search";
  files: SearchWorkerFile[];
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 单文件最多保留的匹配数（与主线程 runProjectSearch 的 200 一致）。 */
  maxMatchesPerFile: number;
}

export interface SearchWorkerResponse {
  id: number;
  ok: boolean;
  results?: SearchWorkerResult[];
  error?: string;
}

self.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const { id, type, files, query, matchCase, wholeWord, regex, maxMatchesPerFile } = event.data;
  if (type !== "search") return;
  try {
    const results: SearchWorkerResult[] = [];
    for (const file of files) {
      if (!file.content) continue;
      const lines = file.content.split("\n");
      const matches = findTextMatches(lines, query, { matchCase, wholeWord, regex });
      for (const match of matches.slice(0, maxMatchesPerFile)) {
        results.push({
          path: file.path,
          name: file.name,
          relPath: file.relPath,
          dirPath: file.dirPath,
          lineNumber: match.lineNumber,
          preview: lines[match.lineNumber - 1] ?? "",
          matchStart: match.startColumn,
          matchEnd: match.endColumn,
        });
      }
    }
    const response: SearchWorkerResponse = { id, ok: true, results };
    self.postMessage(response);
  } catch (error) {
    const response: SearchWorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
