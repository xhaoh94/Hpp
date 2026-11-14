/** Hpp Git 工作台的最小跨进程协议。 */

export interface GitFileChange {
  path: string;
  /** porcelain 的两位状态码，例如 M、A、??。 */
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  success: boolean;
  repoRoot?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  clean?: boolean;
  files?: GitFileChange[];
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
