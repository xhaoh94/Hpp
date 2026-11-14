import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeManager } from "./worktree-manager";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepo = (root: string, subdir?: string) => {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "hpp-test@example.com"]);
  git(root, ["config", "user.name", "Hpp Test"]);
  if (subdir) mkdirSync(join(root, subdir), { recursive: true });
  writeFileSync(join(root, subdir || "", "README.md"), "hello\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
};

describe("WorktreeManager", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const path of temps.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("creates an isolated worktree, checkpoints and merges it back", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-worktree-"));
    temps.push(root);
    createRepo(join(root, "repo"));
    const manager = new WorktreeManager(join(root, "worktrees"));

    const created = await manager.create(join(root, "repo"), "session-1");
    expect(created.success).toBe(true);
    const workspace = created.workspace!;
    expect(workspace.branch.startsWith("hpp/")).toBe(true);
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(workspace.rootPath).toBe(workspace.worktreePath);

    writeFileSync(join(workspace.worktreePath, "feature.txt"), "worktree change\n", "utf8");
    const dirty = await manager.status(workspace);
    expect(dirty.success).toBe(true);
    expect(dirty.dirty).toBe(true);
    expect(dirty.changes?.some((line) => line.includes("feature.txt"))).toBe(true);

    expect((await manager.checkpoint(workspace)).success).toBe(true);
    expect((await manager.status(workspace)).dirty).toBe(false);

    const merged = await manager.merge(workspace);
    expect(merged.success).toBe(true);
    expect(existsSync(join(root, "repo", "feature.txt"))).toBe(true);

    const removed = await manager.remove(workspace);
    expect(removed.success).toBe(true);
    expect(existsSync(workspace.worktreePath)).toBe(false);
  });

  it("supports a project nested inside the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-worktree-subdir-"));
    temps.push(root);
    createRepo(join(root, "repo"), "packages/app");
    const manager = new WorktreeManager(join(root, "worktrees"));

    const created = await manager.create(join(root, "repo", "packages/app"), "session-nested");
    expect(created.success).toBe(true);
    const workspace = created.workspace!;
    expect(workspace.rootPath).toBe(join(workspace.worktreePath, "packages/app"));
    expect(existsSync(workspace.rootPath)).toBe(true);
    expect(workspace.repoRoot).toBe(join(root, "repo"));
  });

  it("reports whether a project can create a worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-worktree-probe-"));
    temps.push(root);
    const repo = join(root, "repo");
    createRepo(repo);
    const manager = new WorktreeManager(join(root, "worktrees"));
    expect(await manager.probe(repo)).toMatchObject({ supported: true, isGitRepo: true, clean: true });
    writeFileSync(join(repo, "dirty.txt"), "dirty\n", "utf8");
    expect(await manager.probe(repo)).toMatchObject({ supported: true, isGitRepo: true, clean: false });
  });

  it("keeps the conflict state when merging a conflicting worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-worktree-conflict-"));
    temps.push(root);
    const repo = join(root, "repo");
    createRepo(repo);
    const manager = new WorktreeManager(join(root, "worktrees"));
    const created = await manager.create(repo, "session-conflict");
    const workspace = created.workspace!;

    writeFileSync(join(workspace.worktreePath, "README.md"), "feature\n", "utf8");
    expect((await manager.checkpoint(workspace)).success).toBe(true);
    writeFileSync(join(repo, "README.md"), "main\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "main change"]);

    const merged = await manager.merge(workspace);
    expect(merged.success).toBe(false);
    expect(merged.conflict).toBe(true);
    expect(git(repo, ["status", "--porcelain"]).split(/\r?\n/).some((line) => line.includes("UU README.md"))).toBe(true);
    git(repo, ["merge", "--abort"]);
  });

  it("refuses to create from a dirty main worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-worktree-dirty-"));
    temps.push(root);
    const repo = join(root, "repo");
    createRepo(repo);
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n", "utf8");
    const manager = new WorktreeManager(join(root, "worktrees"));

    const created = await manager.create(repo, "session-dirty");
    expect(created.success).toBe(false);
    expect(created.error).toContain("未提交");
  });

  it("reports a non-git directory instead of creating a worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "hpp-worktree-nongit-"));
    temps.push(root);
    const manager = new WorktreeManager(join(root, "worktrees"));
    const created = await manager.create(root, "session-nongit");
    expect(created.success).toBe(false);
    expect(created.error).toBeTruthy();
  });
});
