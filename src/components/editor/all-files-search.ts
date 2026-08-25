import { findTextMatches, type TextSearchOptions } from "@/lib/text-search";

export interface AllFilesSearchResult {
  path: string;
  name: string;
  relPath: string;
  dirPath: string;
  lineNumber: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface AllFilesSearchFile {
  path: string;
  name: string;
  relPath: string;
  dirPath: string;
}

export const ALL_FILES_MAX_MATCHES_PER_FILE = 200;
export const ALL_FILES_MAX_RESULTS = 5000;

/**
 * 用当前文档内容计算单个文件的所有文件搜索结果。
 * 与搜索 Worker / 主线程回退路径共用同一套匹配规则和单文件上限。
 */
export function searchAllFilesContent(
  file: AllFilesSearchFile,
  content: string,
  query: string,
  options: TextSearchOptions,
  maxMatchesPerFile = ALL_FILES_MAX_MATCHES_PER_FILE,
): AllFilesSearchResult[] {
  const lines = content.split("\n");
  return findTextMatches(lines, query, options)
    .slice(0, Math.max(0, maxMatchesPerFile))
    .map((match) => ({
      ...file,
      lineNumber: match.lineNumber,
      preview: lines[match.lineNumber - 1] ?? "",
      matchStart: match.startColumn,
      matchEnd: match.endColumn,
    }));
}

/**
 * 将某个文件的新匹配结果替换回项目级结果集。
 * 如果文件原来有结果，则把新结果放回原文件结果的首个位置，避免编辑时
 * 其它文件的顺序和查找栏当前索引发生不必要的整体漂移。
 */
export function replaceAllFilesSearchResults(
  results: AllFilesSearchResult[],
  filePath: string,
  nextFileResults: AllFilesSearchResult[],
  maxResults = ALL_FILES_MAX_RESULTS,
): AllFilesSearchResult[] {
  const firstIndex = results.findIndex((result) => result.path === filePath);
  const withoutFile = results.filter((result) => result.path !== filePath);
  const boundedResults = nextFileResults.slice(0, Math.max(0, maxResults));

  if (firstIndex < 0) {
    return [...results, ...boundedResults].slice(0, Math.max(0, maxResults));
  }

  const insertionIndex = Math.min(firstIndex, withoutFile.length);
  return [
    ...withoutFile.slice(0, insertionIndex),
    ...boundedResults,
    ...withoutFile.slice(insertionIndex),
  ].slice(0, Math.max(0, maxResults));
}
