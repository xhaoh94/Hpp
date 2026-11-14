import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Git workspace modal", () => {
  it("uses the main-process Git API for status, diff, staging, commit and stash", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    expect(source).toContain("gitStatus(target.path)");
    expect(source).toContain("gitDiff(target.path");
    expect(source).toContain("gitStage(target.path");
    expect(source).toContain("gitUnstage(target.path");
    expect(source).toContain("gitDiscard(target.path");
    expect(source).toContain("gitCommit(target.path");
    expect(source).toContain("gitStashCreate(target.path");
    expect(source).toContain("gitStashList(target.path");
    expect(source).toContain("gitStashPop(target.path");
  });

  it("is a wide standalone modal rather than a sidebar panel", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    const styles = read("src/components/git/GitWorkspaceModal.css");
    expect(source).toContain('className="git-workspace-overlay"');
    expect(source).toContain('className="git-workspace-modal"');
    expect(styles).toContain(".git-workspace-overlay");
    expect(styles).toContain("width: min(1120px, calc(100vw - 48px))");
    expect(styles).toContain("grid-template-columns: 330px minmax(0, 1fr)");
  });
});
