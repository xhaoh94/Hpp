import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { GitService, repoNameFromCloneUrl } from "./git-service";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepo = (root: string) => {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "hpp-test@example.com"]);
  git(root, ["config", "user.name", "Hpp Test"]);
  writeFileSync(join(root, "README.md"), "hello\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
};

// 每个用例要反复起 git 子进程，默认 5s 在满载并行时会假超时。
describe("GitService", { timeout: 20_000 }, () => {
  const temps: string[] = [];
  const service = new GitService();

  afterEach(() => {
    for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("reads status, stages, diffs and commits a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "feature.ts"), "export const value = 1;\n", "utf8");

    const dirty = await service.status(root);
    expect(dirty.success).toBe(true);
    expect(dirty.clean).toBe(false);
    expect(dirty.files?.[0]).toMatchObject({ path: "feature.ts", untracked: true });

    expect((await service.stage(root, ["feature.ts"])).success).toBe(true);
    const staged = await service.status(root);
    expect(staged.files?.[0]).toMatchObject({ path: "feature.ts", staged: true, untracked: false });

    const diff = await service.diff(root, "feature.ts", true);
    expect(diff.success).toBe(true);
    expect(diff.patch).toContain("export const value = 1");

    const committed = await service.commit(root, "add feature", false);
    expect(committed.success).toBe(true);
    expect((await service.status(root)).clean).toBe(true);
  });

  it("stages POSIX filenames containing backslashes literally", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "hpp-git-backslash-"));
    temps.push(root);
    createRepo(root);
    const artifact = "C:\\temp\\hpp-artifact.log";
    mkdirSync(join(root, "C:\\temp"), { recursive: true });
    writeFileSync(join(root, artifact), "artifact\n", "utf8");

    const status = await service.status(root);
    expect(status.files?.some((file) => file.path === artifact)).toBe(true);
    expect((await service.stage(root, [artifact])).success).toBe(true);
    expect((await service.commit(root, "add artifact", false)).success).toBe(true);
  });

  it("reads staged rename diffs using the new path", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-rename-"));
    temps.push(root);
    createRepo(root);
    git(root, ["mv", "README.md", "EADME.md"]);

    const status = await service.status(root);
    expect(status.files?.[0]?.path).toBe("EADME.md");
    const diff = await service.diff(root, "EADME.md", true);
    expect(diff.success).toBe(true);
    expect(diff.patch).toContain("EADME.md");
    expect(diff.patch).toContain("+hello");
  });

  it("lists branches, creates/switches/deletes one, and reads history", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-branches-"));
    temps.push(root);
    createRepo(root);

    const initial = await service.branches(root);
    expect(initial.success).toBe(true);
    const currentName = initial.branches?.find((branch) => branch.current)?.name;
    expect(currentName).toBeTruthy();
    expect((await service.createBranch(root, "feature/hpp")).success).toBe(true);
    expect((await service.switchBranch(root, "feature/hpp")).success).toBe(true);
    expect((await service.branches(root)).branches?.find((branch) => branch.current)?.name).toBe("feature/hpp");
    expect((await service.switchBranch(root, currentName!)).success).toBe(true);
    expect((await service.deleteBranch(root, "feature/hpp")).success).toBe(true);

    const log = await service.log(root, 10);
    expect(log.success).toBe(true);
    expect(log.entries?.[0]?.subject).toContain("initial");
    const commit = await service.showCommit(root, log.entries![0].hash);
    expect(commit.success).toBe(true);
    expect(commit.patch).toContain("README.md");
  });

  it("refuses to safely delete an unmerged branch but force deletes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-force-branch-"));
    temps.push(root);
    createRepo(root);
    const initial = await service.branches(root);
    const currentName = initial.branches?.find((branch) => branch.current)!.name;

    expect((await service.createBranch(root, "draft/unmerged")).success).toBe(true);
    expect((await service.switchBranch(root, "draft/unmerged")).success).toBe(true);
    writeFileSync(join(root, "draft.txt"), "only on this branch\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "unmerged work"]);
    expect((await service.switchBranch(root, currentName)).success).toBe(true);

    const safe = await service.deleteBranch(root, "draft/unmerged");
    expect(safe.success).toBe(false);
    expect(safe.error).toMatch(/not fully merged/i);

    expect((await service.deleteBranch(root, "draft/unmerged", true)).success).toBe(true);
    expect((await service.branches(root)).branches?.some((branch) => branch.name === "draft/unmerged")).toBe(false);
  });

  it("lists worktrees and removes a non-current worktree", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-worktrees-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const worktreePath = join(base, "wt");
    git(root, ["worktree", "add", "-b", "wt-test", worktreePath]);

    // git 的 worktree list 在 Windows 上输出正斜杠，比较前统一一下
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
    const list = await service.worktrees(root);
    expect(list.success).toBe(true);
    expect(list.worktrees?.some((entry) => normalize(entry.path) === normalize(root) && entry.current)).toBe(true);
    expect(list.worktrees?.some((entry) => normalize(entry.path) === normalize(worktreePath))).toBe(true);
    expect((await service.removeWorktree(root, worktreePath)).success).toBe(true);
  });

  it("detects merge conflicts, resolves a file and continues the merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-conflict-"));
    temps.push(root);
    createRepo(root);
    const file = join(root, "conflict.txt");
    writeFileSync(file, "base\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const baseBranch = (await service.status(root)).branch!;

    git(root, ["switch", "-c", "feature"]);
    writeFileSync(file, "feature\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature change"]);
    git(root, ["switch", baseBranch]);
    writeFileSync(file, "main\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main change"]);
    try { git(root, ["merge", "feature"]); } catch { /* expected conflict */ }

    const conflicted = await service.status(root);
    expect(conflicted.operation).toBe("merge");
    expect(conflicted.conflicted).toBe(true);
    expect(conflicted.files?.some((entry) => entry.conflicted && entry.path === "conflict.txt")).toBe(true);

    expect((await service.resolveConflict(root, "conflict.txt", "ours")).success).toBe(true);
    expect((await service.status(root)).conflicted).toBe(false);
    expect((await service.continueOperation(root)).success).toBe(true);
    expect((await service.status(root)).operation).toBe("none");
    expect(readFileSync(file, "utf8")).toContain("main");
  });

  it("stages and unstages one hunk without touching the other", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-hunks-"));
    temps.push(root);
    createRepo(root);
    const file = join(root, "hunks.txt");
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`);
    writeFileSync(file, lines.join(""), "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "hunks base"]);
    lines[0] = "first changed\n";
    lines[19] = "last changed\n";
    writeFileSync(file, lines.join(""), "utf8");

    const diff = await service.diff(root, "hunks.txt", false);
    expect(diff.success).toBe(true);
    expect(diff.patch).toContain("first changed");
    expect(diff.patch?.split("@@").length).toBeGreaterThanOrEqual(3);

    expect((await service.stageHunks(root, "hunks.txt", [0], "stage")).success).toBe(true);
    const staged = git(root, ["diff", "--cached", "--", "hunks.txt"]);
    const unstaged = git(root, ["diff", "--", "hunks.txt"]);
    expect(staged).toContain("first changed");
    expect(staged).not.toContain("last changed");
    expect(unstaged).toContain("last changed");
    expect(unstaged).not.toContain("first changed");

    expect((await service.stageHunks(root, "hunks.txt", [0], "unstage")).success).toBe(true);
    expect(git(root, ["diff", "--cached", "--", "hunks.txt"])).toBe("");
  });

  it("discards one hunk from the worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-discard-hunk-"));
    temps.push(root);
    createRepo(root);
    const file = join(root, "discard.txt");
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`);
    writeFileSync(file, lines.join(""), "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "discard base"]);
    lines[0] = "first changed\n";
    lines[19] = "last changed\n";
    writeFileSync(file, lines.join(""), "utf8");

    expect((await service.discardHunks(root, "discard.txt", [0])).success).toBe(true);
    const next = readFileSync(file, "utf8");
    // 全局 core.autocrlf=true 时工作区是 CRLF，断言只看内容不看行尾
    expect(next.replace(/\r\n/g, "\n").startsWith("line 1\n")).toBe(true);
    expect(next).toContain("last changed");
    expect(git(root, ["diff", "--", "discard.txt"])).toContain("last changed");
  });

  it("rebases the current branch onto another branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-rebase-"));
    temps.push(root);
    createRepo(root);
    const base = (await service.status(root)).branch!;
    git(root, ["switch", "-c", "feature"]);
    writeFileSync(join(root, "feature.txt"), "feature\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature"]);
    git(root, ["switch", base]);
    writeFileSync(join(root, "main.txt"), "main\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main"]);
    git(root, ["switch", "feature"]);

    const rebased = await service.rebase(root, base);
    expect(rebased.success).toBe(true);
    expect((await service.log(root, 5)).entries?.map((entry) => entry.subject)).toEqual(expect.arrayContaining(["main", "feature"]));
  });

  it("creates, lists and pops a stash", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-stash-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "README.md"), "changed\n", "utf8");

    const created = await service.stashCreate(root, "work in progress");
    expect(created.success).toBe(true);
    expect((await service.status(root)).clean).toBe(true);
    const list = await service.stashList(root);
    expect(list.success).toBe(true);
    expect(list.stashes?.[0]?.message).toContain("work in progress");

    expect((await service.stashPop(root)).success).toBe(true);
    expect((await service.status(root)).clean).toBe(false);
  });

  it("discards an untracked file and rejects paths outside the repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-discard-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "temporary.txt"), "temporary\n", "utf8");

    expect((await service.discard(root, ["temporary.txt"])).success).toBe(true);
    expect(existsSync(join(root, "temporary.txt"))).toBe(false);
    expect((await service.stage(root, ["../outside"])).success).toBe(false);
  });

  it("discards only the worktree change and keeps the staged content", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-discard-staged-"));
    temps.push(root);
    createRepo(root);
    const file = join(root, "README.md");
    writeFileSync(file, "staged version\n", "utf8");
    git(root, ["add", "."]);
    writeFileSync(file, "worktree version\n", "utf8");

    expect((await service.discard(root, ["README.md"])).success).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("staged version");
    expect(readFileSync(file, "utf8")).not.toContain("worktree version");
    expect(git(root, ["diff", "--cached", "--", "README.md"])).toContain("staged version");
    expect(git(root, ["diff", "--", "README.md"])).toBe("");
  });

  it("rewrites commits through interactive rebase (reword + fixup)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-rebase-i-"));
    temps.push(root);
    createRepo(root);
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(root, `${name}.txt`), `${name}\n`, "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", `commit ${name}`]);
    }

    const plan = await service.rebasePlan(root, "HEAD~2");
    expect(plan.success).toBe(true);
    expect(plan.commits?.map((entry) => entry.subject)).toEqual(["commit b", "commit c"]);

    const rebased = await service.interactiveRebase(root, "HEAD~2", [
      { hash: plan.commits![0].hash, action: "reword", message: "commit b reworded" },
      { hash: plan.commits![1].hash, action: "fixup" },
    ]);
    expect(rebased.error).toBeUndefined();
    expect(rebased.success).toBe(true);

    const log = await service.log(root, 10);
    expect(log.entries?.map((entry) => entry.subject)).toEqual(["commit b reworded", "commit a", "initial"]);
  });

  it("drops a commit and rejects steps that do not cover the range", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-rebase-drop-"));
    temps.push(root);
    createRepo(root);
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(root, `${name}.txt`), `${name}\n`, "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", `commit ${name}`]);
    }

    const plan = await service.rebasePlan(root, "HEAD~2");
    const partial = await service.interactiveRebase(root, "HEAD~2", [{ hash: plan.commits![1].hash, action: "pick" }]);
    expect(partial.success).toBe(false);
    expect(partial.error).toContain("数量不一致");

    const dropped = await service.interactiveRebase(root, "HEAD~2", [
      { hash: plan.commits![0].hash, action: "drop" },
      { hash: plan.commits![1].hash, action: "pick" },
    ]);
    expect(dropped.success).toBe(true);
    expect((await service.log(root, 10)).entries?.map((entry) => entry.subject)).toEqual(["commit c", "commit a", "initial"]);
  });

  it("marks a hand-edited conflict as resolved and finishes the merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-mark-"));
    temps.push(root);
    createRepo(root);
    const main = (await service.status(root)).branch!;
    git(root, ["switch", "-c", "other"]);
    writeFileSync(join(root, "README.md"), "other side\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "other side"]);
    git(root, ["switch", main]);
    writeFileSync(join(root, "README.md"), "main side\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main side"]);
    expect((await service.merge(root, "other")).conflict).toBe(true);

    // 手工改完直接标记解决：不再动内容，只把文件加进索引
    writeFileSync(join(root, "README.md"), "resolved by hand\n", "utf8");
    expect((await service.resolveConflict(root, "README.md", "mark")).success).toBe(true);
    const marked = await service.status(root);
    expect(marked.conflicted).toBe(false);
    expect(marked.operation).toBe("merge");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("resolved by hand");

    expect((await service.continueOperation(root)).success).toBe(true);
    const finished = await service.status(root);
    expect(finished.operation).toBe("none");
    expect(finished.clean).toBe(true);
    expect((await service.log(root, 1)).entries?.[0].subject).toContain("Merge");
  });

  it("stops, aborts and finishes a conflicting rebase", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-rebase-conflict-"));
    temps.push(root);
    createRepo(root);
    const main = (await service.status(root)).branch!;
    git(root, ["switch", "-c", "feature"]);
    writeFileSync(join(root, "README.md"), "feature side\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature change"]);
    git(root, ["switch", main]);
    writeFileSync(join(root, "README.md"), "main side\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main change"]);
    git(root, ["switch", "feature"]);

    const rebasing = await service.rebase(root, main);
    expect(rebasing.success).toBe(false);
    expect(rebasing.conflict).toBe(true);
    const conflicted = await service.status(root);
    expect(conflicted.operation).toBe("rebase");
    // 变基过程中 HEAD 是分离的，但对外要显示真实分支名（读 rebase-merge/head-name）
    expect(conflicted.branch).toBe("feature");

    // 中止：回到变基前的提交，工作区干净
    expect((await service.abortOperation(root)).success).toBe(true);
    const aborted = await service.status(root);
    expect(aborted.operation).toBe("none");
    expect(aborted.clean).toBe(true);
    expect(aborted.branch).toBe("feature");
    expect((await service.log(root, 1)).entries?.[0].subject).toBe("feature change");

    // 重来一次，手工解决后继续，feature 提交落到 main 之上
    expect((await service.rebase(root, main)).conflict).toBe(true);
    writeFileSync(join(root, "README.md"), "both sides\n", "utf8");
    expect((await service.resolveConflict(root, "README.md", "mark")).success).toBe(true);
    expect((await service.continueOperation(root)).success).toBe(true);
    const finished = await service.status(root);
    expect(finished.operation).toBe("none");
    expect(finished.clean).toBe(true);
    const subjects = (await service.log(root, 3)).entries?.map((entry) => entry.subject) || [];
    expect(subjects.slice(0, 2)).toEqual(["feature change", "main change"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("both sides");
  });

  it("refuses to continue while conflicts are still unresolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-continue-guard-"));
    temps.push(root);
    createRepo(root);
    const main = (await service.status(root)).branch!;
    git(root, ["switch", "-c", "other"]);
    writeFileSync(join(root, "README.md"), "other\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "other"]);
    git(root, ["switch", main]);
    writeFileSync(join(root, "README.md"), "main\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main"]);
    await service.merge(root, "other");

    const blocked = await service.continueOperation(root);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("冲突");
    // 没有进行中的合并时也不能瞎 continue
    git(root, ["merge", "--abort"]);
    expect((await service.continueOperation(root)).success).toBe(false);
  });

  it("keeps the detached label when HEAD is detached outside a rebase", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-detached-"));
    temps.push(root);
    createRepo(root);
    const head = git(root, ["rev-parse", "--short", "HEAD"]);
    git(root, ["checkout", "--detach", "HEAD"]);

    const status = await service.status(root);
    expect(status.branch).toBe(`(detached) ${head}`);
    expect(status.operation).toBe("none");
  });

  it("reads three-way conflict content and writes the merged result", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-conflict-file-"));
    temps.push(root);
    createRepo(root);
    const file = join(root, "conflict.txt");
    writeFileSync(file, "base\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const baseBranch = (await service.status(root)).branch!;

    git(root, ["switch", "-c", "feature"]);
    writeFileSync(file, "feature\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature change"]);
    git(root, ["switch", baseBranch]);
    writeFileSync(file, "main\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main change"]);
    try { git(root, ["merge", "feature"]); } catch { /* expected conflict */ }

    const resolved = await service.conflictFile(root, "conflict.txt");
    expect(resolved.success).toBe(true);
    expect(resolved.content).toContain("<<<<<<<");
    expect(resolved.stages?.ours).toContain("main");
    expect(resolved.stages?.theirs).toContain("feature");
    expect(resolved.stages?.base).toContain("base");

    expect((await service.writeConflictFile(root, "conflict.txt", "merged\n", true)).success).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("merged");
    expect((await service.status(root)).conflicted).toBe(false);
    expect((await service.writeConflictFile(root, "../escape.txt", "x", true)).success).toBe(false);
  });

  it("pushes the current branch and sets upstream on the first push", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-push-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { cwd: base, encoding: "utf8" });
    git(root, ["remote", "add", "origin", remote]);
    const branch = (await service.status(root)).branch!;

    const pushed = await service.push(root);
    expect(pushed.success).toBe(true);
    expect(pushed.upstream).toBe(`origin/${branch}`);
    expect((await service.status(root)).upstream).toBe(`origin/${branch}`);
  });

  it("deletes files from the worktree but only ones listed in the changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-delete-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "gone.txt"), "x\n", "utf8");

    expect((await service.deleteFiles(root, ["gone.txt"])).success).toBe(true);
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    // 已跟踪但没改动 → 不在变更列表里，不允许被这个接口删
    expect((await service.deleteFiles(root, ["README.md"])).success).toBe(false);
    expect((await service.deleteFiles(root, ["../escape.txt"])).success).toBe(false);
  });

  it("traces per-line authorship", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-blame-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "trace.txt"), "one\ntwo\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "add trace"]);

    const result = await service.blame(root, "trace.txt");
    expect(result.error).toBeUndefined();
    expect(result.lines?.map((line) => line.text)).toEqual(["one", "two"]);
    expect(result.lines?.[0]).toMatchObject({ author: "Hpp Test", summary: "add trace" });
    expect(result.lines?.[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.lines?.[0].time).toBeGreaterThan(0);

    writeFileSync(join(root, "untracked.txt"), "x\n", "utf8");
    expect((await service.blame(root, "untracked.txt")).success).toBe(false);
  });

  it("pulls with rebase when local and remote diverged", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-pull-rebase-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { cwd: base, encoding: "utf8" });
    git(root, ["remote", "add", "origin", remote]);
    const branch = (await service.status(root)).branch!;
    expect((await service.push(root)).success).toBe(true);

    const other = join(base, "other");
    execFileSync("git", ["clone", remote, other], { cwd: base, encoding: "utf8" });
    git(other, ["config", "user.email", "hpp-test@example.com"]);
    git(other, ["config", "user.name", "Hpp Test"]);
    writeFileSync(join(other, "remote.txt"), "remote\n", "utf8");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote commit"]);
    git(other, ["push"]);

    writeFileSync(join(root, "local.txt"), "local\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "local commit"]);

    const result = await service.pullRebase(root);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const subjects = (await service.log(root, 10)).entries?.map((entry) => entry.subject) || [];
    expect(subjects[0]).toBe("local commit");
    expect(subjects).toContain("remote commit");
    expect((await service.status(root)).branch).toBe(branch);
  });

  it("separates staged and worktree diffs and unstages a path", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-diff-split-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "README.md"), "hello\nstaged line\n", "utf8");
    git(root, ["add", "."]);
    writeFileSync(join(root, "README.md"), "hello\nstaged line\nworktree line\n", "utf8");

    const staged = await service.diff(root, "README.md", true);
    expect(staged.patch).toContain("+staged line");
    expect(staged.patch).not.toContain("+worktree line");

    const worktree = await service.diff(root, "README.md", false);
    expect(worktree.patch).toContain("+worktree line");
    expect(worktree.patch).not.toContain("+staged line");

    expect((await service.unstage(root, ["README.md"])).success).toBe(true);
    const file = (await service.status(root)).files?.find((item) => item.path === "README.md");
    expect(file).toMatchObject({ staged: false, unstaged: true });
  });

  it("keeps the path intact for the first entry when its index status is a space", async () => {
    // `git status --porcelain -z` 对「未暂存修改」输出 " M path"：早期的 trim()
    // 会吃掉前导空格，路径变成 "ADME.md"，后续 stage/discard 全部 pathspec 不匹配。
    const root = mkdtempSync(join(tmpdir(), "hpp-git-status-space-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "README.md"), "hello\nchanged\n", "utf8");

    const status = await service.status(root);
    expect(status.success).toBe(true);
    expect(status.files).toHaveLength(1);
    expect(status.files?.[0]).toMatchObject({ path: "README.md", staged: false, unstaged: true });
    // 用这个路径必须能真的 stage 上去
    expect((await service.stage(root, ["README.md"])).success).toBe(true);
  });

  it("amends the previous commit instead of adding a new one", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-amend-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "extra.txt"), "x\n", "utf8");
    git(root, ["add", "."]);

    const result = await service.commit(root, "amended message", true);
    expect(result.success).toBe(true);
    const log = await service.log(root, 10);
    expect(log.entries?.map((entry) => entry.subject)).toEqual(["amended message"]);
  });

  it("reads history and a single commit patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-show-"));
    temps.push(root);
    createRepo(root);
    writeFileSync(join(root, "README.md"), "hello\nsecond line\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "second"]);

    const log = await service.log(root, 10);
    expect(log.entries?.map((entry) => entry.subject)).toEqual(["second", "initial"]);
    const hash = log.entries![0].hash;

    const detail = await service.showCommit(root, hash);
    expect(detail.success).toBe(true);
    expect(detail.patch).toContain("+second line");
    // 短哈希也接受，非法输入要拒绝
    expect((await service.showCommit(root, hash.slice(0, 8))).success).toBe(true);
    expect((await service.showCommit(root, "not-a-hash")).success).toBe(false);
    expect((await service.showCommit(root, "--all")).success).toBe(false);
  });

  it("returns commit patches without ANSI colour codes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-show-color-"));
    temps.push(root);
    createRepo(root);
    // 模拟用户在全局配置里开了强制颜色：git show 默认会往管道里塞转义序列
    git(root, ["config", "color.ui", "always"]);
    writeFileSync(join(root, "README.md"), "hello\ncolored\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "colored"]);

    const hash = (await service.log(root, 1)).entries![0].hash;
    const detail = await service.showCommit(root, hash);
    expect(detail.success).toBe(true);
    expect(detail.patch).toContain("+colored");
    expect(detail.patch).not.toContain("\u001b[");
  });

  it("merges a branch and keeps the merge commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-merge-"));
    temps.push(root);
    createRepo(root);
    const main = (await service.status(root)).branch!;
    git(root, ["switch", "-c", "feature"]);
    writeFileSync(join(root, "feature.txt"), "feature\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature work"]);
    git(root, ["switch", main]);

    const merged = await service.merge(root, "feature");
    expect(merged.success).toBe(true);
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toContain("feature");
    expect((await service.log(root, 5)).entries?.[0].subject).toBe("Merge feature");
  });

  it("aborts a conflicting merge and restores the pre-merge state", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-git-abort-"));
    temps.push(root);
    createRepo(root);
    const main = (await service.status(root)).branch!;
    git(root, ["switch", "-c", "other"]);
    writeFileSync(join(root, "README.md"), "other side\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "other side"]);
    git(root, ["switch", main]);
    writeFileSync(join(root, "README.md"), "main side\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main side"]);

    const conflicting = await service.merge(root, "other");
    expect(conflicting.success).toBe(false);
    expect(conflicting.conflict).toBe(true);
    expect((await service.status(root)).operation).toBe("merge");

    expect((await service.abortOperation(root)).success).toBe(true);
    const after = await service.status(root);
    expect(after.operation).toBe("none");
    expect(after.conflicted).toBe(false);
    expect(after.clean).toBe(true);
    expect((await service.log(root, 5)).entries?.[0].subject).toBe("main side");
  });

  it("fast-forwards on pull and refuses when the histories diverged", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-pull-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { cwd: base, encoding: "utf8" });
    git(root, ["remote", "add", "origin", remote]);
    expect((await service.push(root)).success).toBe(true);

    const other = join(base, "other");
    execFileSync("git", ["clone", remote, other], { cwd: base, encoding: "utf8" });
    git(other, ["config", "user.email", "hpp-test@example.com"]);
    git(other, ["config", "user.name", "Hpp Test"]);
    writeFileSync(join(other, "remote.txt"), "remote\n", "utf8");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote commit"]);
    git(other, ["push"]);

    // 本地没有分叉 → 快进成功
    const fastForward = await service.pull(root);
    expect(fastForward.success).toBe(true);
    expect(existsSync(join(root, "remote.txt"))).toBe(true);

    // 再造一次分叉 → --ff-only 必须拒绝
    writeFileSync(join(other, "remote2.txt"), "remote2\n", "utf8");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote commit 2"]);
    git(other, ["push"]);
    writeFileSync(join(root, "local.txt"), "local\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "local commit"]);

    const diverged = await service.pull(root);
    expect(diverged.success).toBe(false);
    expect(diverged.error).toContain("fast-forward");
  });

  it("fetches from the remote and reports how far behind it is", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-fetch-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { cwd: base, encoding: "utf8" });
    git(root, ["remote", "add", "origin", remote]);
    expect((await service.push(root)).success).toBe(true);

    const other = join(base, "other");
    execFileSync("git", ["clone", remote, other], { cwd: base, encoding: "utf8" });
    git(other, ["config", "user.email", "hpp-test@example.com"]);
    git(other, ["config", "user.name", "Hpp Test"]);
    writeFileSync(join(other, "remote.txt"), "remote\n", "utf8");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote commit"]);
    git(other, ["push"]);

    expect((await service.status(root)).behind).toBe(0);
    expect((await service.fetch(root)).success).toBe(true);
    expect((await service.status(root)).behind).toBe(1);
  });

  it("reports ahead and behind together from the porcelain branch header", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-diverged-status-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { cwd: base, encoding: "utf8" });
    git(root, ["remote", "add", "origin", remote]);
    expect((await service.push(root)).success).toBe(true);

    const other = join(base, "other");
    execFileSync("git", ["clone", remote, other], { cwd: base, encoding: "utf8" });
    git(other, ["config", "user.email", "hpp-test@example.com"]);
    git(other, ["config", "user.name", "Hpp Test"]);
    writeFileSync(join(other, "remote.txt"), "remote\n", "utf8");
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "remote commit"]);
    git(other, ["push"]);

    // 本地领先 1 个提交，同时远端也多 1 个。
    writeFileSync(join(root, "local.txt"), "local\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "local commit"]);
    expect((await service.fetch(root)).success).toBe(true);

    const status = await service.status(root);
    expect(status.success).toBe(true);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(1);
    expect(status.upstream).toMatch(/^origin\//);
  });

  it("probes git projects and clones from a local source", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-clone-"));
    temps.push(base);
    const source = join(base, "source repo");
    createRepo(source);
    const plain = join(base, "plain");
    mkdirSync(plain, { recursive: true });

    expect(await service.probeRepo(source)).toMatchObject({ success: true, isRepo: true });
    expect((await service.probeRepo(source)).branch).toBeTruthy();
    expect((await service.probeRepo(plain)).isRepo).toBe(false);
    expect((await service.probeRepo(join(base, "missing"))).isRepo).toBe(false);
    expect((await service.probeRepo("")).success).toBe(false);

    const parent = join(base, "clones");
    const cloned = await service.clone(source, parent, "my-repo");
    expect(cloned.error).toBeUndefined();
    expect(cloned.success).toBe(true);
    expect(cloned.path).toBe(join(parent, "my-repo"));
    expect(existsSync(join(parent, "my-repo", "README.md"))).toBe(true);

    // 目标目录非空时拒绝，避免把已有项目覆盖掉
    const again = await service.clone(source, parent, "my-repo");
    expect(again.success).toBe(false);
    expect(again.error).toContain("已存在");
    expect((await service.clone("--upload-pack=evil", parent, "x")).success).toBe(false);
  });
});

describe("repoNameFromCloneUrl", () => {
  it("derives the folder name from common clone URLs", () => {
    expect(repoNameFromCloneUrl("https://github.com/foo/bar.git")).toBe("bar");
    expect(repoNameFromCloneUrl("git@github.com:foo/bar.git")).toBe("bar");
    expect(repoNameFromCloneUrl("https://host/foo/")).toBe("foo");
    expect(repoNameFromCloneUrl("ssh://git@host:22/foo/bar")).toBe("bar");
    expect(repoNameFromCloneUrl("https://github.com/foo/my repo.git")).toBe("my-repo");
    expect(repoNameFromCloneUrl("")).toBe("repo");
  });
});
