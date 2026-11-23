/**
 * 子 Agent 级 worktree 隔离。
 *
 * worker 是独立进程，调不到主进程的 WorktreeManager，所以这里按同一套命名
 * 约定自己实现：
 * - 路径：<worktreeBaseDir>/<projectHash>/sub-<taskId>
 * - 分支：hpp-sub/<taskId>（不能用 hpp/<session>/<taskId>：git 引用不能同时是
 *   文件和目录，会和会话级 hpp/<segment> 冲突）
 * - 基线：`git stash create` 生成一个包含主工作区未提交改动的临时提交；没有
 *   改动时退回 HEAD。未跟踪文件另外复制进去（受 50MB 上限约束）。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_UNTRACKED_COPY_BYTES = 50 * 1024 * 1024;

const run = (cwd, args, { input, timeout = 120_000 } = {}) => new Promise((resolvePromise) => {
  let child;
  try {
    child = spawn("git", args, { cwd, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  } catch (error) {
    resolvePromise({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
    return;
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise(result);
  };
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    finish({ ok: false, stdout, stderr: `${stderr}\ngit ${args[0]} timed out` });
  }, timeout);
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("error", (error) => finish({ ok: false, stdout, stderr: `${stderr}\n${error.message}` }));
  child.once("close", (code) => finish({ ok: code === 0, stdout, stderr, code }));
  if (input !== undefined) {
    try {
      child.stdin?.end(input);
    } catch {
      // close/error 会给出真实原因。
    }
  }
});

const git = async (cwd, args, options) => {
  const result = await run(cwd, args, options);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return result.stdout;
};

const sanitizeSegment = (value) => (
  String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "task"
);

const hashProject = (repoRoot) => createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);

const isWithin = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const listUntracked = async (repoRoot) => {
  const output = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output.split("\0").filter(Boolean);
};

/**
 * 创建隔离工作区。返回的 rootPath 是对应「子 Agent 项目根」的目录：
 * 项目本身就是仓库根时等于 worktreePath，否则是仓库内对应的子目录。
 */
export const createSubagentWorktree = async ({ projectCwd, baseDir, taskId }) => {
  if (!baseDir) throw new Error("未配置 worktree 根目录");
  const projectRoot = resolve(projectCwd || process.cwd());
  if (!existsSync(projectRoot)) throw new Error(`项目目录不存在：${projectRoot}`);
  let repoRoot;
  try {
    repoRoot = (await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error("隔离工作区需要 Git 仓库，当前项目不是 Git 仓库。");
  }
  repoRoot = resolve(repoRoot);
  const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (!head) throw new Error("仓库还没有任何 commit，无法创建隔离工作区。");

  // stash create 只生成提交对象，不动主工作区。
  let baseCommit = head;
  try {
    const stash = (await git(repoRoot, ["stash", "create"])).trim();
    if (stash) baseCommit = stash;
  } catch {
    // 没有可储藏内容或 stash 不可用时退回 HEAD。
  }

  const projectRelative = relative(repoRoot, projectRoot);
  if (!isWithin(repoRoot, projectRoot) && projectRelative !== "") {
    throw new Error("项目目录不在 Git 仓库内，无法创建隔离工作区。");
  }

  const projectHash = hashProject(repoRoot);
  const segment = sanitizeSegment(taskId);
  const worktreePath = join(baseDir, projectHash, `sub-${segment}`);
  if (existsSync(worktreePath)) {
    throw new Error(`隔离工作区目录已存在：${worktreePath}`);
  }
  mkdirSync(join(baseDir, projectHash), { recursive: true });

  let branch = `hpp-sub/${segment}`;
  const branchExists = await run(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists.ok) branch = `${branch}-${Date.now().toString(36)}`;

  await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);

  // stash create 不含未跟踪文件；把它们逐个复制进新工作区。先统计总量，
  // 避免复制到一半才失败留下不完整的工作区。
  const untracked = await listUntracked(repoRoot);
  let totalBytes = 0;
  const files = [];
  for (const path of untracked) {
    const source = join(repoRoot, path);
    try {
      const info = await stat(source);
      if (!info.isFile()) continue;
      totalBytes += info.size;
      files.push({ path, source });
    } catch {
      // 竞态删除的文件直接跳过。
    }
  }
  if (totalBytes > MAX_UNTRACKED_COPY_BYTES) {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    await git(repoRoot, ["branch", "-D", branch]).catch(() => undefined);
    throw new Error(
      `未跟踪文件合计 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，超过 ${Math.round(MAX_UNTRACKED_COPY_BYTES / 1024 / 1024)}MB 上限；请先归档或忽略这些文件。`,
    );
  }
  for (const file of files) {
    const target = join(worktreePath, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.source, target).catch(() => undefined);
  }
  // 关键：把复制进来的未跟踪文件也纳入基线提交。
  // 否则它们在 worktree 里天然是 untracked，`git status` 会把「什么都没改」
  // 误判成有改动，apply 时还会因为主工作区已存在同名文件而失败。
  if (files.length > 0) {
    await git(worktreePath, [
      "-c", "user.name=Hpp",
      "-c", "user.email=hpp@localhost",
      "add", "-A",
    ]);
    await git(worktreePath, [
      "-c", "user.name=Hpp",
      "-c", "user.email=hpp@localhost",
      "commit", "-q", "-m", "hpp subagent baseline: untracked files",
    ]);
    baseCommit = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  }

  return {
    repoRoot,
    projectRoot,
    projectRelative,
    rootPath: projectRelative === "" || projectRelative === "." ? worktreePath : join(worktreePath, projectRelative),
    worktreePath,
    branch,
    baseCommit,
  };
};

const removeWorktree = async (repoRoot, worktreePath, branch) => {
  // 两步都可能失败（worktree 被占用、分支已被删），不能静默当成功：
  // 调用方需要知道是否真的清干净了。
  const removed = await run(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  const branchDeleted = await run(repoRoot, ["branch", "-D", branch]);
  // 顺手清掉空的 projectHash 父目录，避免 worktrees 根下一堆空目录。
  try { await rmdir(dirname(worktreePath)); } catch { /* 非空或不存在 */ }
  const errors = [removed, branchDeleted]
    .filter((result) => !result.ok)
    .map((result) => result.stderr.trim() || result.stdout.trim())
    .filter(Boolean);
  return {
    removed: removed.ok,
    branchDeleted: branchDeleted.ok,
    ...(errors.length > 0 ? { error: errors.join("\n") } : {}),
  };
};

/**
 * 结束隔离任务：有改动就提交并返回分支信息，没有改动就清理掉。
 */
export const finalizeSubagentWorktree = async (info, { taskId, message, discard = false } = {}) => {
  // 被用户中断的任务不提交半成品：直接清掉工作区与分支。
  if (discard) {
    const cleanup = await removeWorktree(info.repoRoot, info.worktreePath, info.branch);
    return { ...info, changed: false, discarded: true, cleanup };
  }
  const status = (await git(info.worktreePath, ["status", "--porcelain"])).trim();
  // 「工作区干净」不等于「没有改动」：子 Agent 可能在 worktree 里自己
  // git commit / stash / reset，改动已经落在 hpp-sub/<id> 分支上。
  // 必须用分支 tip 是否超出 base 判定，否则会把子 Agent 的提交连同分支删掉。
  const tip = (await git(info.worktreePath, ["rev-parse", "HEAD"])).trim();
  const autoCommitted = tip !== info.baseCommit;
  if (!status && !autoCommitted) {
    // 被 .gitignore 忽略的产物不会出现在普通 status 里，直接删工作区会把它们
    // 一起丢掉。检测到就保留现场，交给用户/主 Agent 判断，不自动提交构建产物。
    const ignored = await run(info.worktreePath, ["status", "--porcelain", "--ignored=matching"]);
    const ignoredFiles = ignored.ok
      ? ignored.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("!! "))
        .map((line) => line.slice(3).trim())
        .filter((path) => path && !path.startsWith("node_modules/") && !path.startsWith(".git/"))
      : [];
    if (ignoredFiles.length > 0) {
      return { ...info, changed: false, retained: true, ignoredFiles };
    }
    const cleanup = await removeWorktree(info.repoRoot, info.worktreePath, info.branch);
    return { ...info, changed: false, cleanup };
  }
  if (status) {
    await git(info.worktreePath, [
      "-c", "user.name=Hpp",
      "-c", "user.email=hpp@localhost",
      "add", "-A",
    ]);
    await git(info.worktreePath, [
      "-c", "user.name=Hpp",
      "-c", "user.email=hpp@localhost",
      "commit", "-m", message || `hpp subagent ${taskId || "task"}`,
    ]);
  }
  const diffStat = (await git(info.repoRoot, ["diff", "--stat", info.baseCommit, info.branch])).trim();
  return { ...info, changed: true, autoCommitted, diffStat };
};

const conflictingFiles = (text) => {
  const files = new Set();
  const value = String(text || "");
  for (const match of value.matchAll(/(?:error:\s*patch failed:\s*|error:\s*)([^\s:]+\.\w+):/g)) {
    files.add(match[1]);
  }
  for (const match of value.matchAll(/Applied patch to '([^']+)' with conflicts/g)) {
    files.add(match[1]);
  }
  return [...files];
};

/**
 * 把隔离分支的改动应用回主工作区。
 *
 * 用 `git diff --binary base branch | git apply --3way`：主工作区有未提交改动
 * 也能工作，且二进制文件不会坏。
 */
export const applySubagentWorktree = async (info, { taskId } = {}) => {
  const patch = await git(info.repoRoot, ["diff", "--binary", info.baseCommit, info.branch]);
  if (!patch.trim()) {
    const cleanup = await removeWorktree(info.repoRoot, info.worktreePath, info.branch);
    return { applied: false, reason: "empty", files: [], cleanup };
  }
  const applied = await run(info.repoRoot, ["apply", "--3way", "--binary"], { input: patch });
  let applyResult = applied;
  if (!applyResult.ok) {
    // 主工作区里的未跟踪文件不在 index 里，`--3way` 会直接报
    // "does not exist in index"。这类补丁用普通 apply 精确匹配上下文即可；
    // git apply 默认原子失败，不会留下半截改动。
    const plain = await run(info.repoRoot, ["apply", "--binary"], { input: patch });
    if (plain.ok) applyResult = plain;
  }
  if (!applyResult.ok) {
    // 3way 有冲突时可能 exit 1 但仍在工作区留下冲突标记；用 unmerged 列表
    // 作为最可靠的文件来源，文本解析只做兜底。
    const unmerged = await run(info.repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
    const staged = await run(info.repoRoot, ["diff", "--cached", "--name-only"]);
    const unmergedFiles = unmerged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const stagedFiles = staged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const files = new Set([
      ...unmergedFiles,
      ...conflictingFiles(applyResult.stderr),
      ...conflictingFiles(applyResult.stdout),
      ...conflictingFiles(applied.stderr),
      ...conflictingFiles(applied.stdout),
    ]);
    return {
      applied: false,
      reason: "conflict",
      files: [...files],
      unmergedFiles,
      stagedFiles,
      ...(files.size > 0
        ? { recovery: `git restore --staged --worktree -- ${[...files].map((file) => JSON.stringify(file)).join(" ")}` }
        : {}),
      error: applyResult.stderr.trim() || applyResult.stdout.trim()
        || applied.stderr.trim() || applied.stdout.trim()
        || "git apply failed",
    };
  }
  const cleanup = await removeWorktree(info.repoRoot, info.worktreePath, info.branch);
  return { applied: true, files: [], cleanup };
};

export const removeSubagentWorktree = (info) => removeWorktree(info.repoRoot, info.worktreePath, info.branch);