import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { GitService } from "./git-service";

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

describe("GitService", () => {
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

  it("lists worktrees and removes a non-current worktree", async () => {
    const base = mkdtempSync(join(tmpdir(), "hpp-git-worktrees-"));
    temps.push(base);
    const root = join(base, "repo");
    createRepo(root);
    const worktreePath = join(base, "wt");
    git(root, ["worktree", "add", "-b", "wt-test", worktreePath]);

    const list = await service.worktrees(root);
    expect(list.success).toBe(true);
    expect(list.worktrees?.some((entry) => entry.path === root && entry.current)).toBe(true);
    expect(list.worktrees?.some((entry) => entry.path === worktreePath)).toBe(true);
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
    expect(next.startsWith("line 1\n")).toBe(true);
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
});
