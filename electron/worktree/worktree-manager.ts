import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, relative, resolve, sep } from "path";
import { promisify } from "util";

import type {
  SessionWorkspace,
  WorktreeActionResult,
  WorktreeCreateResult,
  WorktreeProbeResult,
  WorktreeStatusResult,
} from "../../shared/session-workspace";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

function errorMessage(error: unknown) {
  const stderr = (error as { stderr?: string | Buffer } | null)?.stderr;
  const detail = stderr ? String(stderr).trim() : "";
  if (detail) return detail.split(/\r?\n/).slice(0, 4).join("\n");
  return error instanceof Error ? error.message : String(error);
}

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return String(stdout || "").trim();
}

const validSessionSegment = (sessionId: string) => {
  const value = sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return value || randomUUID().slice(0, 8);
};

const normalizeWorkspace = (workspace: SessionWorkspace): SessionWorkspace => ({ ...workspace });

/**
 * 会话级 Git worktree。
 *
 * 只负责文件系统/Git 操作，不直接修改项目 store；调用方拿到工作区信息后
 * 写进 ProjectSession.workspace，再把它作为 Agent 的 cwd。
 */
export class WorktreeManager {
  constructor(private readonly configuredBaseDir?: string) {}

  private get baseDir() {
    return this.configuredBaseDir
      || join(process.env.HPP_DATA_DIR || join(homedir(), ".config", "hpp", "hpp-data"), "worktrees");
  }

  async probe(projectPath: string): Promise<WorktreeProbeResult> {
    const projectRoot = resolve(projectPath);
    if (!existsSync(projectRoot)) {
      return { supported: false, isGitRepo: false, clean: false, error: `项目目录不存在：${projectRoot}` };
    }
    try {
      const repoRootOutput = await runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
      const repoRoot = realpathSync(repoRootOutput);
      const status = await runGit(repoRoot, ["status", "--porcelain"]);
      return { supported: true, isGitRepo: true, clean: !status };
    } catch (error) {
      return { supported: false, isGitRepo: false, clean: false, error: `不是 Git 仓库：${errorMessage(error)}` };
    }
  }

  async create(projectPath: string, sessionId: string): Promise<WorktreeCreateResult> {
    const projectRoot = resolve(projectPath);
    if (!existsSync(projectRoot)) return { success: false, error: `项目目录不存在：${projectRoot}` };

    try {
      const repoRootOutput = await runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
      const repoRoot = realpathSync(repoRootOutput);
      const status = await runGit(repoRoot, ["status", "--porcelain"]);
      if (status) {
        return {
          success: false,
          error: "主工作区有未提交改动。独立工作区只能从干净的 HEAD 创建，请先提交或暂存改动，或继续使用共享工作区。",
        };
      }

      let baseRef = "HEAD";
      try {
        baseRef = await runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]) || "HEAD";
      } catch {
        // detached HEAD 也能从当前 commit 创建
      }
      const baseCommit = await runGit(repoRoot, ["rev-parse", "HEAD"]);
      if (!baseCommit) return { success: false, error: "仓库还没有 commit，无法创建 worktree。" };

      const projectRelative = relative(repoRoot, projectRoot);
      if (projectRelative === ".." || projectRelative.startsWith(`..${sep}`)) {
        return { success: false, error: "项目目录不在 Git 仓库内，无法创建 worktree。" };
      }

      const segment = validSessionSegment(sessionId);
      const projectHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
      const worktreePath = join(this.baseDir, projectHash, segment);
      if (existsSync(worktreePath)) {
        return { success: false, error: `工作区目录已存在：${worktreePath}` };
      }

      let branch = `hpp/${segment}`;
      try {
        await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        branch = `${branch}-${Date.now().toString(36)}`;
      } catch {
        // 分支不存在，正常创建
      }

      mkdirSync(join(this.baseDir, projectHash), { recursive: true });
      await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);

      const rootPath = projectRelative === "." ? worktreePath : join(worktreePath, projectRelative);
      const workspace: SessionWorkspace = {
        mode: "worktree",
        projectRoot,
        repoRoot,
        rootPath,
        worktreePath,
        branch,
        baseRef,
        baseCommit,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      return { success: true, workspace };
    } catch (error) {
      return { success: false, error: `创建 worktree 失败：${errorMessage(error)}` };
    }
  }

  async status(workspace: SessionWorkspace): Promise<WorktreeStatusResult> {
    if (!workspace?.worktreePath || !existsSync(workspace.worktreePath)) {
      return {
        success: false,
        workspace: { ...workspace, status: "missing" },
        error: "worktree 目录不存在。",
      };
    }
    try {
      const output = await runGit(workspace.worktreePath, ["status", "--porcelain"]);
      const changes = output ? output.split(/\r?\n/).filter(Boolean) : [];
      return { success: true, workspace: normalizeWorkspace(workspace), dirty: changes.length > 0, changes };
    } catch (error) {
      return { success: false, workspace: normalizeWorkspace(workspace), error: errorMessage(error) };
    }
  }

  async checkpoint(workspace: SessionWorkspace, message?: string): Promise<WorktreeActionResult> {
    if (!workspace?.worktreePath || !existsSync(workspace.worktreePath)) {
      return { success: false, workspace: { ...workspace, status: "missing" }, error: "worktree 目录不存在。" };
    }
    try {
      await runGit(workspace.worktreePath, ["add", "-A"]);
      const changes = await runGit(workspace.worktreePath, ["status", "--porcelain"]);
      if (!changes) return { success: true, workspace: normalizeWorkspace(workspace), output: "没有需要提交的改动。" };
      const commitMessage = message?.trim() || `Hpp checkpoint: ${workspace.branch}`;
      await runGit(workspace.worktreePath, ["commit", "-m", commitMessage]);
      return { success: true, workspace: normalizeWorkspace(workspace), output: commitMessage };
    } catch (error) {
      return { success: false, workspace: normalizeWorkspace(workspace), error: `创建检查点失败：${errorMessage(error)}` };
    }
  }

  async merge(workspace: SessionWorkspace): Promise<WorktreeActionResult> {
    if (!workspace?.worktreePath || !existsSync(workspace.worktreePath)) {
      return { success: false, workspace: { ...workspace, status: "missing" }, error: "worktree 目录不存在。" };
    }
    try {
      const mainStatus = await runGit(workspace.repoRoot, ["status", "--porcelain"]);
      if (mainStatus) {
        return { success: false, workspace: normalizeWorkspace(workspace), error: "主工作区有未提交改动，请先清理后再合并。" };
      }
      await runGit(workspace.repoRoot, ["merge", "--no-ff", workspace.branch, "-m", `Merge ${workspace.branch}`]);
      return { success: true, workspace: { ...workspace, status: "merged" }, output: `已合并 ${workspace.branch}` };
    } catch (error) {
      try {
        await runGit(workspace.repoRoot, ["merge", "--abort"]);
      } catch {
        // 没有可中止的合并
      }
      return { success: false, workspace: normalizeWorkspace(workspace), error: `合并失败，已回滚：${errorMessage(error)}` };
    }
  }

  async remove(workspace: SessionWorkspace): Promise<WorktreeActionResult> {
    if (!workspace?.worktreePath) return { success: false, error: "缺少 worktree 路径。" };
    try {
      try {
        await runGit(workspace.repoRoot, ["worktree", "remove", "--force", workspace.worktreePath]);
      } catch (error) {
        // 目录已经不存在时 prune 掉 Git 的登记即可。
        if (existsSync(workspace.worktreePath)) throw error;
        await runGit(workspace.repoRoot, ["worktree", "prune"]).catch(() => undefined);
      }
      try {
        await runGit(workspace.repoRoot, ["branch", "-D", workspace.branch]);
      } catch {
        // 分支可能已被合并/删除
      }
      return { success: true, workspace: { ...workspace, status: "discarded" }, output: "worktree 已删除。" };
    } catch (error) {
      return { success: false, workspace: normalizeWorkspace(workspace), error: `删除 worktree 失败：${errorMessage(error)}` };
    }
  }
}

export const worktreeManager = new WorktreeManager();
