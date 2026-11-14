/** Hpp Git 工作台的最小跨进程协议。 */

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

export interface GitStashEntry {
  ref: string;
  message: string;
}

export interface GitStashListResult {
  success: boolean;
  stashes?: GitStashEntry[];
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
