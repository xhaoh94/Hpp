import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import {
  applySubagentWorktree,
  createSubagentWorktree,
  finalizeSubagentWorktree,
} from "./subagent-worktree.mjs";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("Pi 子 Agent worktree 隔离", () => {
  let root = "";
  let repo = "";
  let baseDir = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-pi-worktree-"));
    repo = join(root, "repo");
    baseDir = join(root, "worktrees");
    await mkdir(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    await writeFile(join(repo, "app.txt"), "line1\nline2\nline3\n", "utf8");
    await writeFile(join(repo, "other.txt"), "other\n", "utf8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("基线包含主工作区未提交改动和未跟踪文件", async () => {
    await writeFile(join(repo, "app.txt"), "line1\nmodified\nline3\n", "utf8");
    await writeFile(join(repo, "untracked.txt"), "new file\n", "utf8");

    const info = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_bg1" });
    expect(info.branch).toBe("hpp-sub/w_bg1");
    expect(info.worktreePath.startsWith(baseDir)).toBe(true);
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(await readFile(join(info.worktreePath, "app.txt"), "utf8")).toContain("modified");
    expect(await readFile(join(info.worktreePath, "untracked.txt"), "utf8")).toBe("new file\n");
  });

  it("结束时自动提交有改动的分支，并可以合并回主工作区", async () => {
    const info = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_bg2" });
    await writeFile(join(info.worktreePath, "app.txt"), "line1\nsubagent change\nline3\n", "utf8");

    const finished = await finalizeSubagentWorktree(info, { taskId: "w_bg2" });
    expect(finished.changed).toBe(true);
    expect(finished.diffStat).toContain("app.txt");
    expect(git(repo, ["show", `${finished.branch}:app.txt`])).toContain("subagent change");

    const applied = await applySubagentWorktree(finished, { taskId: "w_bg2" });
    expect(applied).toMatchObject({ applied: true });
    expect(await readFile(join(repo, "app.txt"), "utf8")).toContain("subagent change");
    expect(existsSync(finished.worktreePath)).toBe(false);
    expect(() => git(repo, ["show-ref", "--verify", `refs/heads/${finished.branch}`])).toThrow();
  });

  it("未跟踪草稿文件不算子 Agent 的改动", async () => {
    await writeFile(join(repo, "draft.txt"), "draft\n", "utf8");
    const info = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_untracked" });
    expect(await readFile(join(info.worktreePath, "draft.txt"), "utf8")).toContain("draft");

    // 子 Agent 没改任何东西：基线提交把草稿文件纳入后，工作区应当是干净的。
    const finished = await finalizeSubagentWorktree(info, { taskId: "w_untracked" });
    expect(finished.changed).toBe(false);
    expect(existsSync(finished.worktreePath)).toBe(false);
  });

  it("子 Agent 修改未跟踪草稿文件后可以正常 apply", async () => {
    await writeFile(join(repo, "draft.txt"), "draft\n", "utf8");
    const info = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_draft" });
    await writeFile(join(info.worktreePath, "draft.txt"), "draft changed by subagent\n", "utf8");

    const finished = await finalizeSubagentWorktree(info, { taskId: "w_draft" });
    expect(finished.changed).toBe(true);
    const applied = await applySubagentWorktree(finished, { taskId: "w_draft" });
    expect(applied).toMatchObject({ applied: true });
    expect(await readFile(join(repo, "draft.txt"), "utf8")).toContain("changed by subagent");
  });

  it("子 Agent 自己 commit 后 finalize 不会删掉分支", async () => {
    const info = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_commit" });
    await writeFile(join(info.worktreePath, "app.txt"), "line1\nsubagent own commit\nline3\n", "utf8");
    git(info.worktreePath, ["add", "-A"]);
    git(info.worktreePath, ["commit", "-q", "-m", "subagent own commit"]);

    // 工作区是干净的，但分支 tip 已经超出 base：不能当成「无改动」删掉。
    const finished = await finalizeSubagentWorktree(info, { taskId: "w_commit" });
    expect(finished.changed).toBe(true);
    expect(finished.autoCommitted).toBe(true);
    expect(existsSync(finished.worktreePath)).toBe(true);

    const applied = await applySubagentWorktree(finished, { taskId: "w_commit" });
    expect(applied).toMatchObject({ applied: true });
    expect(await readFile(join(repo, "app.txt"), "utf8")).toContain("subagent own commit");
  });

  it("没有改动时清理 worktree 和分支", async () => {
    const info = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_clean" });
    const finished = await finalizeSubagentWorktree(info, { taskId: "w_clean" });
    expect(finished.changed).toBe(false);
    // 清理结果要可观测：以前两步 git 命令的返回码全被丢掉。
    expect(finished.cleanup).toMatchObject({ removed: true, branchDeleted: true });
    expect(existsSync(finished.worktreePath)).toBe(false);
    expect(() => git(repo, ["show-ref", "--verify", `refs/heads/${finished.branch}`])).toThrow();
  });

  it("两个子任务改同一处时，第二次合并返回冲突文件并保留现场", async () => {
    const first = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_a" });
    const second = await createSubagentWorktree({ projectCwd: repo, baseDir, taskId: "w_b" });
    await writeFile(join(first.worktreePath, "app.txt"), "line1\nfrom A\nline3\n", "utf8");
    await writeFile(join(second.worktreePath, "app.txt"), "line1\nfrom B\nline3\n", "utf8");
    const firstDone = await finalizeSubagentWorktree(first, { taskId: "w_a" });
    const secondDone = await finalizeSubagentWorktree(second, { taskId: "w_b" });

    await expect(applySubagentWorktree(firstDone, { taskId: "w_a" })).resolves.toMatchObject({ applied: true });
    const conflict = await applySubagentWorktree(secondDone, { taskId: "w_b" });
    expect(conflict.applied).toBe(false);
    expect(conflict.reason).toBe("conflict");
    expect(conflict.files).toContain("app.txt");
    // 冲突要让主 Agent 知道有哪些未合并文件、怎么恢复本地版本。
    expect(conflict.unmergedFiles ?? []).toContain("app.txt");
    expect(String(conflict.recovery)).toContain("git restore");
    // 冲突时保留现场，交给主 Agent 处理。
    expect(existsSync(secondDone.worktreePath)).toBe(true);
  });

  it("非 Git 仓库直接报错", async () => {
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });
    await expect(createSubagentWorktree({ projectCwd: plain, baseDir, taskId: "w_x" }))
      .rejects.toThrow(/Git/);
  });
});