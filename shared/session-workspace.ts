/** 会话级工作区：共享项目目录，或独立 Git worktree。 */

export interface SessionWorkspace {
  mode: "worktree";
  /** 用户最初加入 Hpp 的项目路径。 */
  projectRoot: string;
  /** git rev-parse --show-toplevel */
  repoRoot: string;
  /** 传给 Agent 的实际 cwd（项目是仓库子目录时带上相对路径）。 */
  rootPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  status: "active" | "merged" | "discarded" | "missing";
  createdAt: string;
}

export interface WorktreeProbeResult {
  supported: boolean;
  isGitRepo: boolean;
  clean: boolean;
  error?: string;
}

export interface WorktreeCreateResult {
  success: boolean;
  workspace?: SessionWorkspace;
  error?: string;
}

export interface WorktreeStatusResult {
  success: boolean;
  workspace?: SessionWorkspace;
  dirty?: boolean;
  changes?: string[];
  error?: string;
}

export interface WorktreeActionResult {
  success: boolean;
  workspace?: SessionWorkspace;
  error?: string;
  output?: string;
}
