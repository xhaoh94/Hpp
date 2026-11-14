import { execFile } from "child_process";
import { existsSync, rmSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { promisify } from "util";

import type {
  GitActionResult,
  GitCommitResult,
  GitDiffResult,
  GitFileChange,
  GitStashListResult,
  GitStatus,
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
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
    files.push({
      path: filePath,
      status: code,
      staged: !untracked && code[0] !== " ",
      unstaged: !untracked && code[1] !== " ",
      untracked,
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

      return { success: true, repoRoot: root, branch, upstream, ahead, behind, clean: files.length === 0, files };
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
}

export const gitService = new GitService();
