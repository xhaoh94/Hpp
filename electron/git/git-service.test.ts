import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
