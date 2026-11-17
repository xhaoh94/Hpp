import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Git workspace performance guards", () => {
  const service = read("electron/git/git-service.ts");
  const methodBody = (signature: string) => {
    const start = service.indexOf(signature);
    if (start < 0) return "";
    const next = service.indexOf("\n  }", start);
    return service.slice(start, next);
  };

  it("reads branch and ahead/behind from one porcelain status call", () => {
    const status = methodBody("async status(target: string)");
    expect(status).toContain('"status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"');
    // status 内不再为 upstream 单独跑 rev-parse / rev-list。
    expect(status).not.toContain('runGit(root, ["rev-parse", "@{u}")');
    expect(status).not.toContain('runGit(root, ["rev-list"');
  });

  it("checks in-progress operations from the filesystem instead of five git queries", () => {
    const operation = methodBody("private async operation(root: string)");
    expect(operation).toContain('"rev-parse", "--absolute-git-dir"');
    expect(operation).not.toContain('"--git-path"');
  });

  it("uses lightweight pathspec status for single-file checks and caches repo roots", () => {
    const service = read("electron/git/git-service.ts");
    expect(service).toContain('"--", ...paths');
    expect(service).toContain("repoRootCache");
    expect(service).toContain("REPO_ROOT_TTL_MS");
  });

  it("debounces focus refresh, parallelizes refresh, and guards stale diff responses", () => {
    const modal = read("src/components/git/GitWorkspaceModal.tsx");
    expect(modal).toContain("window.setTimeout(silentRefresh, 300)");
    expect(modal).toContain("Promise.all([");
    expect(modal).toContain("diffRequestRef");
    const store = read("src/components/git/git-op-log-store.ts");
    expect(store).toContain("MAX_ENTRIES = 200");
    expect(modal).toContain("useGitOpLog()");
  });

  it("virtualizes diff rows instead of mounting every line", () => {
    const view = read("src/components/git/GitDiffView.tsx");
    expect(view).toContain('from "@tanstack/react-virtual"');
    expect(view).toContain("useVirtualizer");
    expect(view).toContain("getVirtualItems()");
    const modal = read("src/components/git/GitWorkspaceModal.tsx");
    expect(modal).toContain("<GitDiffView");
    expect(modal).not.toContain("hunk.lines.map((line, index)");
  });

  it("reuses the parent scroll container instead of nesting a second scrollbar", () => {
    const view = read("src/components/git/GitDiffView.tsx");
    const blame = read("src/components/git/GitBlamePanel.tsx");
    const styles = read("src/components/git/GitWorkspaceModal.css");
    for (const source of [view, blame]) {
      expect(source).toContain("parentElement");
      expect(source).toContain("setScrollElement");
    }
    const virtualRule = styles.slice(styles.indexOf(".git-diff-virtual {"), styles.indexOf("}", styles.indexOf(".git-diff-virtual {")));
    const blameRule = styles.slice(styles.indexOf(".git-blame-rows {"), styles.indexOf("}", styles.indexOf(".git-blame-rows {")));
    expect(virtualRule).not.toContain("overflow: auto");
    expect(blameRule).not.toContain("overflow: auto");
  });
});
