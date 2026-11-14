import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { promisify } from "util";

import { buildGitPatchForHunks, parseGitPatch } from "../../shared/git-hunks";
import type {
  GitActionResult,
  GitBranch,
  GitBranchListResult,
  GitCommitDiffResult,
  GitCommitResult,
  GitDiffResult,
  GitFileChange,
  GitLogEntry,
  GitLogResult,
  GitConflictChoice,
  GitOperation,
  GitStashListResult,
  GitStatus,
  GitWorktreeEntry,
  GitWorktreeListResult,
} from "../../shared/git-types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

type GitResult = { stdout: string; stderr: string; code: number };

function errorMessage(error: unknown) {
  const stderr = (error as { stderr?: string | Buffer } | null)?.stderr;
  const detail = stderr ? String(stderr).trim() : "";
  if (detail) return detail.split(/\r?\n/).slice(0, 5).join("\n");
  return error instanceof Error ? error.message : String(error);
}

async function runGitResult(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
    });
    return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
    if (typeof failure.code === "number") {
      return {
        stdout: String(failure.stdout || ""),
        stderr: String(failure.stderr || ""),
        code: failure.code,
      };
    }
    throw error;
  }
}

async function runGit(cwd: string, args: string[]) {
  const result = await runGitResult(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} 退出码 ${result.code}`);
  }
  return result.stdout.trim();
}

const safePath = (value: unknown) => {
  if (typeof value !== "string") throw new Error("文件路径无效。");
  // Git 在 POSIX 上会把反斜杠当普通文件名字符（测试临时目录可能真的叫 C:\\temp...）；
  // 只有 Windows 才需要把路径分隔符统一成斜杠。
  const normalized = (process.platform === "win32" ? value.replace(/\\/g, "/") : value).replace(/^\.\/+/, "").trim();
  if (!normalized || normalized.startsWith("/") || isAbsolute(normalized)) throw new Error("文件路径必须是仓库相对路径。");
  if (normalized.split("/").some((part) => part === ".." || part === "")) throw new Error("文件路径不能跳出仓库。");
  return normalized;
};

const safePaths = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("没有选择文件。");
  return [...new Set(value.map(safePath))];
};

const parseStatus = (output: string): GitFileChange[] => {
  const parts = output.split("\0");
  const files: GitFileChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    // porcelain -z 对 rename/copy 追加一个原始路径条目。
    if (code[0] === "R" || code[0] === "C") index += 1;
    const untracked = code === "??";
    const conflicted = code.includes("U") || code === "AA" || code === "DD";
    files.push({
      path: filePath,
      status: code,
      staged: !untracked && code[0] !== " ",
      unstaged: !untracked && code[1] !== " ",
      untracked,
      ...(conflicted ? { conflicted } : {}),
    });
  }
  return files;
};

export class GitService {
  async repoRoot(target: string): Promise<string> {
    const path = resolve(target);
    if (!existsSync(path)) throw new Error(`目录不存在：${path}`);
    return resolve(await runGit(path, ["rev-parse", "--show-toplevel"]));
  }

  async status(target: string): Promise<GitStatus> {
    try {
      const root = await this.repoRoot(target);
      let branch = "";
      try {
        branch = await runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
      } catch {
        branch = `(detached) ${await runGit(root, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD")}`;
      }
      const raw = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const files = parseStatus(raw);

      let upstream: string | undefined;
      let ahead = 0;
      let behind = 0;
      try {
        upstream = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        const counts = await runGit(root, ["rev-list", "--left-right", "--count", `@{u}...HEAD`]);
        const [left, right] = counts.split(/\s+/).map((value) => Number(value) || 0);
        behind = left;
        ahead = right;
      } catch {
        // 没有 upstream 的本地仓库
      }

      const operation = await this.operation(root);
      return {
        success: true,
        repoRoot: root,
        branch,
        upstream,
        ahead,
        behind,
        clean: files.length === 0,
        files,
        operation,
        conflicted: files.some((file) => file.conflicted),
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async diff(target: string, filePath: unknown, staged: unknown): Promise<GitDiffResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      const status = await this.status(target);
      const file = status.files?.find((item) => item.path === path);
      if (file?.untracked) {
        const result = await runGitResult(root, ["diff", "--no-index", "--no-ext-diff", "--", process.platform === "win32" ? "NUL" : "/dev/null", path]);
        return { success: true, patch: result.stdout, untracked: true };
      }
      const args = ["diff", "--no-ext-diff", "--unified=3"];
      if (staged === true) args.push("--cached");
      args.push("--", path);
      const result = await runGitResult(root, args);
      if (result.code !== 0 && !result.stdout) throw new Error(result.stderr.trim() || "读取 diff 失败。");
      return {
        success: true,
        patch: result.stdout,
        binary: /^Binary files /m.test(result.stdout),
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async stageHunks(target: string, filePath: unknown, indexes: unknown, direction: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      const unstage = direction === "unstage";
      const diff = await this.diff(target, path, unstage);
      if (!diff.success) throw new Error(diff.error || "读取 diff 失败。");
      const parsed = parseGitPatch(diff.patch || "");
      if (parsed.hunks.length === 0) throw new Error("这个文件没有可按块操作的 diff。");
      const selected = Array.isArray(indexes) ? indexes.map((value) => Number(value)) : [];
      const patch = buildGitPatchForHunks(parsed, selected);
      if (!patch) throw new Error("选择的 hunk 无效。");
      const temporary = join(tmpdir(), `hpp-git-hunk-${randomUUID()}.patch`);
      writeFileSync(temporary, patch, "utf8");
      try {
        await runGit(root, ["apply", "--cached", ...(unstage ? ["--reverse"] : []), "--whitespace=nowarn", temporary]);
      } finally {
        rmSync(temporary, { force: true });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async stage(target: string, paths: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const files = safePaths(paths);
      await runGit(root, ["add", "--", ...files]);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async unstage(target: string, paths: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const files = safePaths(paths);
      const result = await runGitResult(root, ["reset", "-q", "HEAD", "--", ...files]);
      if (result.code !== 0) {
        // 空仓库还没有 HEAD
        await runGit(root, ["rm", "--cached", "-r", "--", ...files]);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async discardHunks(target: string, filePath: unknown, indexes: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      const diff = await this.diff(target, path, false);
      if (!diff.success) throw new Error(diff.error || "读取 diff 失败。");
      const parsed = parseGitPatch(diff.patch || "");
      const selected = Array.isArray(indexes) ? indexes.map((value) => Number(value)) : [];
      const patch = buildGitPatchForHunks(parsed, selected);
      if (!patch) throw new Error("选择的 hunk 无效。");
      const temporary = join(tmpdir(), `hpp-git-discard-${randomUUID()}.patch`);
      writeFileSync(temporary, patch, "utf8");
      try {
        await runGit(root, ["apply", "--reverse", "--whitespace=nowarn", temporary]);
      } finally {
        rmSync(temporary, { force: true });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async discard(target: string, paths: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const files = safePaths(paths);
      const status = await this.status(target);
      for (const path of files) {
        const file = status.files?.find((item) => item.path === path);
        if (file?.untracked) {
          const absolute = resolve(root, path);
          const relativePath = relative(root, absolute);
          if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
            throw new Error(`拒绝删除仓库外路径：${path}`);
          }
          rmSync(absolute, { recursive: true, force: true });
          continue;
        }
        await runGit(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async commit(target: string, message: unknown, amend: unknown): Promise<GitCommitResult> {
    try {
      const root = await this.repoRoot(target);
      const text = typeof message === "string" ? message.trim() : "";
      if (!text) return { success: false, error: "提交信息不能为空。" };
      const staged = await runGitResult(root, ["diff", "--cached", "--quiet"]);
      if (staged.code === 0 && amend !== true) return { success: false, error: "没有已暂存的改动。" };
      const args = ["commit", "-m", text];
      if (amend === true) args.push("--amend");
      await runGit(root, args);
      const commit = await runGit(root, ["rev-parse", "--short", "HEAD"]).catch(() => "");
      return { success: true, commit, output: text };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async stashCreate(target: string, message: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const text = typeof message === "string" && message.trim() ? message.trim() : "Hpp: 临时暂存";
      const output = await runGit(root, ["stash", "push", "-u", "-m", text]);
      if (/No local changes/i.test(output)) return { success: false, error: "没有可暂存的改动。" };
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async stashList(target: string): Promise<GitStashListResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["stash", "list", "--format=%gd%x09%s"]);
      const stashes = output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [ref, ...rest] = line.split("\t");
        return { ref, message: rest.join("\t") };
      });
      return { success: true, stashes };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async stashPop(target: string, ref: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const stashRef = typeof ref === "string" && /^stash@\{\d+\}$/.test(ref) ? ref : undefined;
      const output = await runGit(root, ["stash", "pop", ...(stashRef ? [stashRef] : [])]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  private async operation(root: string): Promise<GitOperation> {
    const has = async (name: string) => {
      try {
        const path = await runGit(root, ["rev-parse", "--git-path", name]);
        return existsSync(resolve(root, path));
      } catch {
        return false;
      }
    };
    if (await has("rebase-merge") || await has("rebase-apply")) return "rebase";
    if (await has("MERGE_HEAD")) return "merge";
    if (await has("CHERRY_PICK_HEAD")) return "cherry-pick";
    if (await has("REVERT_HEAD")) return "revert";
    return "none";
  }

  async resolveConflict(target: string, filePath: unknown, choice: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      const status = await this.status(target);
      const file = status.files?.find((item) => item.path === path);
      if (!file?.conflicted) throw new Error("该文件当前没有冲突。");
      const action = choice === "ours" || choice === "theirs" || choice === "mark" ? choice : null;
      if (!action) throw new Error("未知的冲突处理方式。");
      if (action !== "mark") {
        await runGit(root, ["checkout", action === "ours" ? "--ours" : "--theirs", "--", path]);
      }
      await runGit(root, ["add", "--", path]);
      return { success: true, output: action === "mark" ? "已标记为解决" : `已使用${action === "ours" ? "当前" : "对方"}版本` };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async continueOperation(target: string): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const status = await this.status(target);
      if (!status.operation || status.operation === "none") throw new Error("当前没有进行中的合并或 rebase。");
      if (status.conflicted) throw new Error("还有未解决的冲突文件。");
      const command = status.operation === "merge" ? "merge"
        : status.operation === "rebase" ? "rebase"
          : status.operation === "cherry-pick" ? "cherry-pick" : "revert";
      const output = await runGit(root, [command, "--continue"]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async abortOperation(target: string): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const status = await this.status(target);
      if (!status.operation || status.operation === "none") throw new Error("当前没有进行中的合并或 rebase。");
      const command = status.operation === "merge" ? "merge"
        : status.operation === "rebase" ? "rebase"
          : status.operation === "cherry-pick" ? "cherry-pick" : "revert";
      const output = await runGit(root, [command, "--abort"]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async branches(target: string): Promise<GitBranchListResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["for-each-ref", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)", "refs/heads"]);
      const branches: GitBranch[] = output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [name, head, upstream] = line.split("\0");
        return { name, current: head === "*", ...(upstream ? { upstream } : {}) };
      });
      return { success: true, branches };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async createBranch(target: string, name: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const branch = await this.validBranchName(root, name);
      await runGit(root, ["branch", "--", branch]);
      return { success: true, output: `已创建 ${branch}` };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async switchBranch(target: string, name: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const branch = await this.validBranchName(root, name);
      const output = await runGit(root, ["switch", branch]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async deleteBranch(target: string, name: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const branch = await this.validBranchName(root, name);
      const output = await runGit(root, ["branch", "-d", "--", branch]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async log(target: string, limit = 50): Promise<GitLogResult> {
    try {
      const root = await this.repoRoot(target);
      const count = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 200);
      const output = await runGit(root, ["log", `--max-count=${count}`, "--date=iso-strict", "--pretty=format:%H%x00%h%x00%an%x00%ad%x00%s"]);
      const entries: GitLogEntry[] = output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [hash, shortHash, author, date, subject] = line.split("\0");
        return { hash, shortHash, author, date, subject };
      });
      return { success: true, entries };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async showCommit(target: string, hash: unknown): Promise<GitCommitDiffResult> {
    try {
      const root = await this.repoRoot(target);
      const commit = typeof hash === "string" ? hash.trim() : "";
      if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new Error("提交哈希无效。");
      const patch = await runGit(root, ["show", "--no-ext-diff", "--patch", "--format=fuller", commit]);
      return { success: true, patch };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async fetch(target: string): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["fetch", "--prune"]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async pull(target: string): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["pull", "--ff-only"]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async push(target: string): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["push"]);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async merge(target: string, branchName: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const branch = await this.validBranchName(root, branchName);
      const output = await runGit(root, ["merge", "--no-ff", branch, "-m", `Merge ${branch}`]);
      return { success: true, output };
    } catch (error) {
      const status = await this.status(target);
      return {
        success: false,
        error: `合并未完成：${errorMessage(error)}`,
        ...(status.operation === "merge" ? { conflict: !!status.conflicted } : {}),
      };
    }
  }

  async rebase(target: string, branchName: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const branch = await this.validBranchName(root, branchName);
      const output = await runGit(root, ["rebase", branch]);
      return { success: true, output };
    } catch (error) {
      const status = await this.status(target);
      return {
        success: false,
        error: `rebase 未完成：${errorMessage(error)}`,
        ...(status.operation === "rebase" ? { conflict: !!status.conflicted } : {}),
      };
    }
  }

  async worktrees(target: string): Promise<GitWorktreeListResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["worktree", "list", "--porcelain"]);
      const entries: GitWorktreeEntry[] = [];
      let current: GitWorktreeEntry | null = null;
      const push = () => { if (current) entries.push(current); current = null; };
      for (const line of output.split(/\r?\n/)) {
        if (!line) { push(); continue; }
        if (line.startsWith("worktree ")) {
          push();
          current = { path: line.slice("worktree ".length), current: resolve(line.slice("worktree ".length)) === resolve(root) };
        } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
        else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
        else if (current && line === "detached") current.detached = true;
        else if (current && line === "bare") current.bare = true;
      }
      push();
      return { success: true, worktrees: entries };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async removeWorktree(target: string, worktreePath: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const path = typeof worktreePath === "string" ? resolve(worktreePath) : "";
      if (!path) throw new Error("缺少 worktree 路径。");
      if (path === resolve(root)) throw new Error("不能删除主工作区。");
      await runGit(root, ["worktree", "remove", "--force", path]);
      return { success: true, output: "worktree 已删除。" };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  private async validBranchName(root: string, value: unknown): Promise<string> {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(name)) throw new Error("分支名无效。");
    const checked = await runGit(root, ["check-ref-format", "--branch", name]);
    return checked.trim() || name;
  }
}

export const gitService = new GitService();
