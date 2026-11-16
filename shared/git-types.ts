/** Hpp Git 工作台的最小跨进程协议。 */

export interface GitRepoProbeResult {
  success: boolean;
  isRepo: boolean;
  repoRoot?: string;
  /** 当前分支；分离 HEAD 或空仓库时为空。 */
  branch?: string;
  error?: string;
}

export interface GitCloneResult {
  success: boolean;
  /** 克隆出来的本地目录。 */
  path?: string;
  output?: string;
  error?: string;
}

export interface GitFileChange {
  path: string;
  /** porcelain 的两位状态码，例如 M、A、??。 */
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted?: boolean;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "none";
export type GitConflictChoice = "ours" | "theirs" | "mark";

export interface GitStatus {
  success: boolean;
  repoRoot?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  clean?: boolean;
  files?: GitFileChange[];
  operation?: GitOperation;
  conflicted?: boolean;
  error?: string;
}

export interface GitDiffResult {
  success: boolean;
  patch?: string;
  untracked?: boolean;
  binary?: boolean;
  error?: string;
}

export interface GitActionResult {
  success: boolean;
  output?: string;
  error?: string;
  conflict?: boolean;
}

export interface GitCommitResult extends GitActionResult {
  commit?: string;
}

export interface GitPushResult extends GitActionResult {
  /** 推送后生效的 upstream（没有时为空）。 */
  upstream?: string;
}

export interface GitStashEntry {
  ref: string;
  /** 储藏说明；已经去掉 git 自动加的 "On <branch>: " 前缀。 */
  message: string;
  /** 储藏时所在的分支，解析不出来时为空。 */
  branch?: string;
}

export interface GitStashListResult {
  success: boolean;
  stashes?: GitStashEntry[];
  error?: string;
}

export interface GitStashFile {
  /** A / M / D / R；stash 时新加的文件（含未跟踪）是 A。 */
  status: string;
  path: string;
}

export interface GitStashFilesResult {
  success: boolean;
  files?: GitStashFile[];
  error?: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
}

export interface GitBranchListResult {
  success: boolean;
  branches?: GitBranch[];
  error?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitLogResult {
  success: boolean;
  entries?: GitLogEntry[];
  error?: string;
}

export interface GitCommitDiffResult {
  success: boolean;
  patch?: string;
  error?: string;
}

/** 交互式变基里单个提交的动作。 */
export type GitRebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface GitRebaseStep {
  hash: string;
  action: GitRebaseAction;
  /** 仅 reword 使用；为空表示保持原信息。 */
  message?: string;
}

export interface GitRebasePlanResult {
  success: boolean;
  /** base 解析后的完整提交哈希。 */
  base?: string;
  /** base..HEAD，按时间正序（最老的在前）。 */
  commits?: GitLogEntry[];
  error?: string;
}

export interface GitBlameLine {
  hash: string;
  author: string;
  /** 提交时间（epoch 秒）。 */
  time: number;
  summary: string;
  text: string;
}

export interface GitBlameResult {
  success: boolean;
  path?: string;
  lines?: GitBlameLine[];
  /** 超过上限只返回前 N 行。 */
  truncated?: boolean;
  error?: string;
}

/** 三方冲突文件：stages 是索引里的 1/2/3 阶段内容，内容可能是二进制。 */
export interface GitConflictFileResult {
  success: boolean;
  path?: string;
  /** 工作区当前内容（通常带冲突标记）。 */
  content?: string;
  /** 工作区文件不存在（modify/delete 冲突删掉了一侧）。 */
  missing?: boolean;
  binary?: boolean;
  stages?: { base?: string; ours?: string; theirs?: string };
  error?: string;
}

export interface GitWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  current?: boolean;
}

export interface GitWorktreeListResult {
  success: boolean;
  worktrees?: GitWorktreeEntry[];
  error?: string;
}
