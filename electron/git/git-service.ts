import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { promisify } from "util";

import { buildGitPatchForHunks, parseGitPatch } from "../../shared/git-hunks";
import type {
  GitActionResult,
  GitBlameLine,
  GitBlameResult,
  GitBranch,
  GitBranchListResult,
  GitCloneResult,
  GitCommitDiffResult,
  GitCommitResult,
  GitConflictFileResult,
  GitDiffResult,
  GitFileChange,
  GitLogEntry,
  GitLogResult,
  GitConflictChoice,
  GitOperation,
  GitPushResult,
  GitRebaseAction,
  GitRebasePlanResult,
  GitRebaseStep,
  GitRepoProbeResult,
  GitStashListResult,
  GitStatus,
  GitWorktreeEntry,
  GitWorktreeListResult,
} from "../../shared/git-types";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
const BLAME_LINE_LIMIT = 20_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

const REBASE_ACTIONS: GitRebaseAction[] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

/** 传给 git 执行的 shell 片段里一律用正斜杠：sh 会把反斜杠当转义符。 */
const toPosixPath = (value: string) => value.replace(/\\/g, "/");

type GitResult = { stdout: string; stderr: string; code: number };

type GitRunOptions = { env?: Record<string, string>; timeoutMs?: number };

function errorMessage(error: unknown) {
  const stderr = (error as { stderr?: string | Buffer } | null)?.stderr;
  const detail = stderr ? String(stderr).trim() : "";
  if (detail) return detail.split(/\r?\n/).slice(0, 5).join("\n");
  return error instanceof Error ? error.message : String(error);
}

async function runGitResult(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  const timeout = options.timeoutMs ?? GIT_TIMEOUT_MS;
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...options.env },
    });
    return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (typeof failure.code === "number") {
      return {
        stdout: String(failure.stdout || ""),
        stderr: String(failure.stderr || ""),
        code: failure.code,
      };
    }
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { stdout: "", stderr: `git 输出过大（超过 ${Math.round(GIT_MAX_BUFFER / 1024 / 1024)}MB）`, code: -1 };
    }
    if (failure.killed || failure.signal) {
      return { stdout: "", stderr: `git 命令超时（${Math.round(timeout / 1000)} 秒）`, code: -1 };
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

/**
 * 不加 trim 的版本：`--porcelain -z` 里未暂存改动的状态码是 " M"，
 * trim 会把前导空格吃掉，路径就少一个字符（" M README.md" → "EADME.md"）。
 */
async function runGitRaw(cwd: string, args: string[]) {
  const result = await runGitResult(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} 退出码 ${result.code}`);
  }
  return result.stdout;
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

/** 从 clone 地址推目录名：foo/bar.git → bar，git@host:foo/bar.git → bar。 */
export function repoNameFromCloneUrl(url: string): string {
  const cleaned = url.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  const base = cleaned.split(/[/\\:]/).filter(Boolean).pop() || "";
  const safe = base.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").replace(/^\.+/, "");
  return safe || "repo";
}

/** 只接受 URL 形式或已存在的本地目录，避免把任意参数塞给 git clone。 */
const isCloneSource = (url: string) => {
  if (!url || url.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return true;
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return true;
  return existsSync(url);
};

export class GitService {
  async repoRoot(target: string): Promise<string> {
    const path = resolve(target);
    if (!existsSync(path)) throw new Error(`目录不存在：${path}`);
    return resolve(await runGit(path, ["rev-parse", "--show-toplevel"]));
  }

  /** 给「项目卡片是否显示 Git 入口」和仓库页签用，不跑 status。 */
  async probeRepo(target: unknown): Promise<GitRepoProbeResult> {
    const path = typeof target === "string" ? target.trim() : "";
    if (!path) return { success: false, isRepo: false, error: "缺少项目路径。" };
    if (!existsSync(path)) return { success: true, isRepo: false };
    try {
      const root = await this.repoRoot(path);
      const branch = await runGitResult(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
      const name = branch.code === 0 ? branch.stdout.trim() : "";
      return { success: true, isRepo: true, repoRoot: root, ...(name ? { branch: name } : {}) };
    } catch {
      return { success: true, isRepo: false };
    }
  }

  async clone(url: unknown, parentDir: unknown, name: unknown): Promise<GitCloneResult> {
    try {
      const source = typeof url === "string" ? url.trim() : "";
      if (!isCloneSource(source)) throw new Error("Git 地址无效：支持 https:// / ssh:// / git@host:repo，或已存在的本地仓库目录。");
      const base = resolve(typeof parentDir === "string" && parentDir.trim() ? parentDir.trim() : homedir());
      const requested = typeof name === "string" && name.trim() ? name.trim() : "";
      const folder = (requested || repoNameFromCloneUrl(source)).replace(/[\\/:*?"<>|]+/g, "-");
      if (!folder || folder === "." || folder === "..") throw new Error("目录名无效。");
      const destination = join(base, folder);
      if (existsSync(destination) && readdirSync(destination).length > 0) {
        throw new Error(`目标目录已存在且非空：${destination}`);
      }
      mkdirSync(base, { recursive: true });

      const result = await runGitResult(base, ["clone", "--progress", "--", source, destination], {
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        return { success: false, error: `克隆失败：${result.stderr.trim().split(/\r?\n/).slice(-6).join("\n")}` };
      }
      return { success: true, path: destination, output: result.stderr.trim() };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async status(target: string): Promise<GitStatus> {
    try {
      const root = await this.repoRoot(target);
      let branch = "";
      let detached = false;
      try {
        branch = await runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
      } catch {
        detached = true;
        branch = `(detached) ${await runGit(root, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD")}`;
      }
      const raw = await runGitRaw(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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
      // 变基期间 HEAD 分离，这里还原成真实分支名，否则界面会显示成 (detached) <hash>
      if (detached && operation === "rebase") {
        branch = (await this.rebaseBranchName(root)) ?? branch;
      }
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
        const result = await runGitResult(root, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", process.platform === "win32" ? "NUL" : "/dev/null", path]);
        return { success: true, patch: result.stdout, untracked: true };
      }
      // 用户的 color.ui=always 会让 patch 带 ANSI，后续 git apply 直接失败。
      const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3"];
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

  /** 只丢工作区改动，暂存区保持原样（调用方只传「未暂存」的路径）。 */
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
        // 不带 --staged：这里只还原成索引里的版本，已暂存的内容不能被顺手抹掉。
        await runGit(root, ["restore", "--worktree", "--", path]);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  /** 从磁盘删掉文件（不是 git 还原）。只允许变更列表里的路径。 */
  async deleteFiles(target: string, paths: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const files = safePaths(paths);
      const status = await this.status(target);
      for (const path of files) {
        if (!status.files?.some((item) => item.path === path)) throw new Error(`文件不在变更列表里：${path}`);
        const absolute = resolve(root, path);
        const relativePath = relative(root, absolute);
        if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
          throw new Error(`拒绝删除仓库外路径：${path}`);
        }
        if (existsSync(absolute)) rmSync(absolute, { recursive: true, force: true });
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

  /** 变基时 HEAD 是分离的，从 rebase 的 head-name 还原正在变基的分支。 */
  private async rebaseBranchName(root: string): Promise<string | null> {
    for (const name of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
      try {
        const path = await runGit(root, ["rev-parse", "--git-path", name]);
        const absolute = resolve(root, path);
        if (!existsSync(absolute)) continue;
        const ref = readFileSync(absolute, "utf8").trim();
        const short = ref.replace(/^refs\/heads\//, "");
        if (short) return short;
      } catch {
        // 读不到就保留 detached 显示
      }
    }
    return null;
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

  /** 逐行追溯：`--line-porcelain` 每行都带完整元数据，解析比 --porcelain 简单。 */
  async blame(target: string, filePath: unknown): Promise<GitBlameResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      const result = await runGitResult(root, ["blame", "--line-porcelain", "--", path]);
      if (result.code !== 0 && !result.stdout) {
        throw new Error(result.stderr.trim() || "读取追溯信息失败。");
      }
      const lines: GitBlameLine[] = [];
      let current: { hash: string; author: string; time: number; summary: string } | null = null;
      for (const raw of result.stdout.split(/\r?\n/)) {
        if (/^\^?[0-9a-f]{40} \d+ \d+/.test(raw)) {
          current = { hash: raw.split(" ")[0].replace(/^\^/, ""), author: "", time: 0, summary: "" };
          continue;
        }
        if (!current) continue;
        if (raw.startsWith("\t")) {
          lines.push({ ...current, text: raw.slice(1) });
          current = null;
          if (lines.length >= BLAME_LINE_LIMIT) break;
          continue;
        }
        if (raw.startsWith("author ")) current.author = raw.slice(7);
        else if (raw.startsWith("author-time ")) current.time = Number(raw.slice(12)) || 0;
        else if (raw.startsWith("summary ")) current.summary = raw.slice(8);
      }
      if (lines.length === 0) throw new Error(result.stderr.trim() || "没有可追溯的内容（可能是二进制文件或未跟踪文件）。");
      return { success: true, path, lines, ...(lines.length >= BLAME_LINE_LIMIT ? { truncated: true } : {}) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async showCommit(target: string, hash: unknown): Promise<GitCommitDiffResult> {
    try {
      const root = await this.repoRoot(target);
      const commit = typeof hash === "string" ? hash.trim() : "";
      if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new Error("提交哈希无效。");
      const patch = await runGit(root, ["show", "--no-ext-diff", "--no-color", "--patch", "--format=fuller", commit]);
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

  /** 拉取并把手上的提交重放到远程之上；冲突时会停在 rebase 状态。 */
  async pullRebase(target: string): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const output = await runGit(root, ["pull", "--rebase"]);
      return { success: true, output };
    } catch (error) {
      const status = await this.status(target);
      return {
        success: false,
        error: `拉取并变基未完成：${errorMessage(error)}`,
        ...(status.operation !== "none" ? { conflict: !!status.conflicted } : {}),
      };
    }
  }

  async push(target: string): Promise<GitPushResult> {
    try {
      const root = await this.repoRoot(target);
      const head = await runGitResult(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
      const branch = head.stdout.trim();
      if (head.code !== 0 || !branch) throw new Error("当前处于分离 HEAD 状态，先切到分支再推送。");

      const upstream = await runGitResult(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      if (upstream.code === 0 && upstream.stdout.trim()) {
        const output = await runGit(root, ["push"]);
        return { success: true, output, upstream: upstream.stdout.trim() };
      }

      // 第一次推送：git push 单独跑会直接失败，必须带上 --set-upstream。
      const remotes = (await runGit(root, ["remote"])).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (remotes.length === 0) throw new Error("仓库没有配置远程（git remote 为空），无法推送。");
      const remote = remotes.includes("origin") ? "origin" : remotes[0];
      const output = await runGit(root, ["push", "--set-upstream", remote, branch]);
      return {
        success: true,
        output: output || `已推送 ${branch}，upstream 设为 ${remote}/${branch}`,
        upstream: `${remote}/${branch}`,
      };
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

  /** base..HEAD，按时间正序：交互式变基的待办列表就用这个顺序。 */
  async rebasePlan(target: string, base: unknown): Promise<GitRebasePlanResult> {
    try {
      const root = await this.repoRoot(target);
      const commit = await this.validRevision(root, base);
      const output = await runGit(root, ["log", "--reverse", "--date=iso-strict", "--pretty=format:%H%x00%h%x00%an%x00%ad%x00%s", `${commit}..HEAD`]);
      const commits: GitLogEntry[] = output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [hash, shortHash, author, date, subject] = line.split("\0");
        return { hash, shortHash, author, date, subject };
      });
      return { success: true, base: commit, commits };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  /**
   * todo 由调用方给，这里只负责写进临时文件再让 git 读走：
   * GIT_SEQUENCE_EDITOR 用 `cp` 覆盖 git 给的 todo 路径（Git for Windows 自带 sh + cp）。
   * reword 不用 `reword` 动作（它要交互式编辑器），改成 pick + `exec git commit --amend -F`。
   */
  async interactiveRebase(target: string, base: unknown, steps: unknown): Promise<GitActionResult> {
    let temp: string | null = null;
    try {
      const root = await this.repoRoot(target);
      const commit = await this.validRevision(root, base);
      const plan = await this.rebasePlan(target, commit);
      if (!plan.success) throw new Error(plan.error || "读取变基范围失败。");
      const ordered = this.normalizeRebaseSteps(plan.commits || [], steps);

      temp = mkdtempSync(join(tmpdir(), "hpp-git-rebase-"));
      const todo: string[] = [];
      ordered.forEach((step, index) => {
        if (step.action === "reword") {
          const messageFile = join(temp as string, `message-${index}.txt`);
          writeFileSync(messageFile, step.message || "", "utf8");
          todo.push(`pick ${step.hash}`, `exec git commit --amend -F "${toPosixPath(messageFile)}"`);
          return;
        }
        todo.push(`${step.action} ${step.hash}`);
      });
      const todoFile = join(temp, "todo");
      writeFileSync(todoFile, `${todo.join("\n")}\n`, "utf8");

      const result = await runGitResult(root, ["rebase", "-i", "--no-autosquash", "--empty=drop", commit], {
        env: { GIT_SEQUENCE_EDITOR: `cp "${toPosixPath(todoFile)}"` },
      });
      const output = `${result.stderr}\n${result.stdout}`.trim();
      const status = await this.status(target);
      if (result.code !== 0) {
        return {
          success: false,
          error: `交互式变基未完成：${output.split(/\r?\n/).filter(Boolean).slice(-5).join("\n") || `退出码 ${result.code}`}`,
          ...(status.operation === "rebase" ? { conflict: !!status.conflicted } : {}),
        };
      }
      if (status.operation === "rebase") {
        return { success: true, output: "已停在 edit 的提交上，改完后点「继续」。" };
      }
      return { success: true, output: output || "变基完成" };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }

  /** 读三方内容：工作区文件（带标记）+ 索引里的 1/2/3 阶段。 */
  async conflictFile(target: string, filePath: unknown): Promise<GitConflictFileResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      const status = await this.status(target);
      if (!status.files?.find((item) => item.path === path)?.conflicted) throw new Error("该文件当前没有冲突。");
      const stages = await this.conflictStages(root, path);
      const absolute = resolve(root, path);
      if (!existsSync(absolute)) return { success: true, path, content: "", missing: true, binary: stages.binary, stages: stages.text };
      const buffer = readFileSync(absolute);
      const binary = stages.binary || buffer.includes(0);
      return {
        success: true,
        path,
        content: binary ? "" : buffer.toString("utf8"),
        binary,
        stages: stages.text,
      };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  async writeConflictFile(target: string, filePath: unknown, content: unknown, stage: unknown): Promise<GitActionResult> {
    try {
      const root = await this.repoRoot(target);
      const path = safePath(filePath);
      if (typeof content !== "string") throw new Error("内容无效。");
      if (content.length > GIT_MAX_BUFFER) throw new Error("内容过大，无法写入。");
      const status = await this.status(target);
      if (!status.files?.find((item) => item.path === path)?.conflicted) throw new Error("该文件当前没有冲突。");
      const absolute = resolve(root, path);
      const relativePath = relative(root, absolute);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`拒绝写入仓库外路径：${path}`);
      }
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
      if (stage === true) await runGit(root, ["add", "--", path]);
      return { success: true, output: stage === true ? "已写入并标记为解决" : "已保存" };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  private async conflictStages(root: string, path: string) {
    const output = await runGitRaw(root, ["ls-files", "-u", "-z", "--", path]);
    const hashes = new Map<number, string>();
    for (const entry of output.split("\0")) {
      const [meta] = entry.split("\t");
      const parts = meta ? meta.split(" ") : [];
      if (parts.length < 3) continue;
      const stage = Number(parts[2]);
      if (stage === 1 || stage === 2 || stage === 3) hashes.set(stage, parts[1]);
    }
    const text: { base?: string; ours?: string; theirs?: string } = {};
    let binary = false;
    const read = async (stage: number, key: "base" | "ours" | "theirs") => {
      const hash = hashes.get(stage);
      if (!hash) return;
      const blob = await runGitResult(root, ["cat-file", "blob", hash]);
      if (blob.stdout.includes("\u0000")) {
        binary = true;
        return;
      }
      text[key] = blob.stdout;
    };
    await read(1, "base");
    await read(2, "ours");
    await read(3, "theirs");
    return { text, binary };
  }

  private normalizeRebaseSteps(plan: GitLogEntry[], steps: unknown): GitRebaseStep[] {
    if (plan.length === 0) throw new Error("所选提交之后没有提交，无法交互式变基。");
    if (!Array.isArray(steps) || steps.length !== plan.length) throw new Error("变基步骤与提交数量不一致。");
    const byHash = new Map(plan.map((entry) => [entry.hash, entry]));
    const seen = new Set<string>();
    const ordered: GitRebaseStep[] = [];
    for (const raw of steps) {
      const step = (raw || {}) as { hash?: unknown; action?: unknown; message?: unknown };
      const hash = typeof step.hash === "string" ? step.hash.trim() : "";
      const entry = byHash.get(hash);
      if (!entry) throw new Error(`提交不在变基范围内：${hash || "(空)"}`);
      if (seen.has(hash)) throw new Error(`提交重复：${entry.shortHash}`);
      seen.add(hash);
      const action = REBASE_ACTIONS.find((item) => item === step.action);
      if (!action) throw new Error(`未知的变基动作：${String(step.action)}`);
      const message = typeof step.message === "string" ? step.message.trim() : "";
      if (action === "reword" && !message) throw new Error(`reword 需要填写新的提交信息：${entry.shortHash}`);
      ordered.push({ hash, action, ...(message ? { message } : {}) });
    }
    if (seen.size !== plan.length) throw new Error("变基步骤必须覆盖范围内的全部提交。");
    if (ordered[0].action === "squash" || ordered[0].action === "fixup") throw new Error("第一个提交不能是 squash / fixup。");
    return ordered;
  }

  private async validRevision(root: string, value: unknown): Promise<string> {
    const revision = typeof value === "string" ? value.trim() : "";
    if (!revision || revision.startsWith("-") || /[\r\n]/.test(revision)) throw new Error("提交引用无效。");
    const result = await runGitResult(root, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`找不到提交：${revision}`);
    return result.stdout.trim();
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
