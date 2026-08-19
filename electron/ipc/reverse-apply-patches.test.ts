import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reverseApplyPatches, type RunGitApply } from "./reverse-apply-patches";

const tempDirs: string[] = [];

const createRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-review-undo-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Hpp Test"], { cwd: dir });
  return dir;
};

const commit = (dir: string, message: string) => {
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
};

const diff = (dir: string) => execFileSync("git", ["diff", "--no-ext-diff"], {
  cwd: dir,
  encoding: "utf8",
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("reverseApplyPatches", () => {
  it("reverts repeated modifications to one file from newest to oldest", () => {
    const dir = createRepo();
    const file = join(dir, "sample.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    commit(dir, "initial");

    writeFileSync(file, "ONE\ntwo\nthree\n");
    const firstPatch = diff(dir);
    commit(dir, "first edit");

    writeFileSync(file, "ONE\nTWO\nthree\n");
    const secondPatch = diff(dir);

    expect(reverseApplyPatches(dir, [firstPatch, secondPatch])).toEqual({ success: true });
    expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\nthree\n");
  });

  it("restores already reverted patches when a later reverse step fails", () => {
    const calls: Array<{ patch: string; reverse: boolean }> = [];
    const run: RunGitApply = (_cwd, patch, reverse) => {
      calls.push({ patch, reverse });
      if (patch === "first" && reverse) {
        return { status: 1, stderr: "first patch failed" };
      }
      return { status: 0 };
    };

    expect(reverseApplyPatches("project", ["first", "second", "third"], run)).toEqual({
      success: false,
      error: "first patch failed",
    });
    expect(calls).toEqual([
      { patch: "third", reverse: true },
      { patch: "second", reverse: true },
      { patch: "first", reverse: true },
      { patch: "second", reverse: false },
      { patch: "third", reverse: false },
    ]);
  });
});
