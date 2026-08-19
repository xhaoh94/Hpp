// 跨文件共享的查找配置：切换编辑器标签页时沿用同一份搜索状态，
// 实现“打开 Ctrl+F 后切换文件仍保持搜索同一关键词”。
export interface SharedSearchConfig {
  searchOpen: boolean;
  searchQuery: string;
  searchMatchCase: boolean;
  searchWholeWord: boolean;
  searchRegex: boolean;
  replaceOpen: boolean;
  replaceQuery: string;
  preserveCase: boolean;
  searchScope: "current" | "all";
  // 上一次“所有文件”搜索使用的参数键（JSON 串），用于跨 pane 去重：
  // 切换标签页或新 pane 挂载时，若参数未变则跳过重复搜索。
  lastAllFilesSearchKey: string;
}

export const sharedSearchConfig: SharedSearchConfig = {
  searchOpen: false,
  searchQuery: "",
  searchMatchCase: false,
  searchWholeWord: false,
  searchRegex: false,
  replaceOpen: false,
  replaceQuery: "",
  preserveCase: false,
  searchScope: "current",
  lastAllFilesSearchKey: "",
};

// 项目级搜索结果点击后，请求对应文件 pane 跳转到指定行。
export const EDITOR_GOTO_MATCH_EVENT = "editor-goto-match";

export interface GotoMatchDetail {
  path: string;
  line: number;
}

// “所有文件”搜索范围内的单个匹配项（供查找框在范围内统计与导航使用）。
export interface AllFileMatch {
  path: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
}

// 跨 pane 的待办跳转：点击“扩大搜索”结果后写入，目标 pane 在文档 ready 后再滚动，
// 避免目标文件尚未加载完成时滚动落空。
export const pendingGoto: { path: string | null; line: number } = {
  path: null,
  line: 0,
};

export function requestGotoMatch(path: string, line: number): void {
  pendingGoto.path = path;
  pendingGoto.line = line;
  window.dispatchEvent(
    new CustomEvent<GotoMatchDetail>(EDITOR_GOTO_MATCH_EVENT, {
      detail: { path, line },
    }),
  );
}

// “所有文件”搜索结果面板中，对单个匹配项执行替换：请求对应文件 pane（若已打开）
// 在其 CodeMirror 视图内就地替换并保持脏标记；文件未打开时由父级走磁盘读写回退。
export const EDITOR_REPLACE_MATCH_EVENT = "editor-replace-match";

export interface ReplaceMatchDetail {
  path: string;
  lineNumber: number;
  // 搜索时记录的原匹配列范围（0 基于），供 pane 在实时文档中重新定位该次出现。
  matchStart: number;
  matchEnd: number;
  // 已套用保留大小写后的最终替换文本（由发起方计算，避免 pane 与预览不一致）。
  replacement: string;
  // 用于 pane 在实时行内重新定位出现的搜索参数。
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export function requestReplaceMatch(detail: ReplaceMatchDetail): void {
  window.dispatchEvent(
    new CustomEvent<ReplaceMatchDetail>(EDITOR_REPLACE_MATCH_EVENT, {
      detail,
    }),
  );
}
