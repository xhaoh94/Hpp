import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFullFileDiff, buildReviewDiff } from "../../shared/patch-split";
import { ReviewUndoService } from "./rebuild-file";

const tempDirs: string[] = [];
const createRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-hunk-repro-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  return dir;
};
const createService = () => {
  const root = mkdtempSync(join(tmpdir(), "hpp-hunk-state-"));
  tempDirs.push(root);
  return new ReviewUndoService({
    stateRoot: join(root, "state"),
    backupRoot: join(root, "backups"),
  });
};
const writeLines = (file: string, lines: string[]) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
};
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hunk undo end-to-end (dialog contract)", () => {
  it("reverts exactly the hunk the dialog's pair view labels", async () => {
    const dir = createRepo();
    const service = createService();
    const file = join(dir, "src", "app.ts");
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeLines(file, base);
    execFileSync("git", ["add", "--all"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: dir });

    // 两个相距很远的独立修改 → canonical patch 应有 2 个 hunk
    const edited = [...base];
    edited[2] = "line 3 EDITED";
    edited[25] = "line 26 EDITED";
    writeLines(file, edited);

    // 前端流程：diffs → buildReviewDiff → reviewSources → prepare
    const diffs = [{ file: "src/app.ts", patch: execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" }), additions: 2, deletions: 0 }];
    const sourceFiles = buildReviewDiff(diffs, dir);
    const reviewSources = sourceFiles.map((f) => ({
      file: f.file,
      patches: f.patches,
      status: f.status,
      statusExplicit: f.statusExplicit === true,
    }));
    const prep = await service.prepare({ reviewId: "msg-1", projectPath: dir, files: reviewSources });
    expect(prep.success).toBe(true);
    if (!prep.success) return;
    const state = prep.state;
    const prepared = state.files[0];
    expect(prepared.hunkCount).toBe(2);

    // 对话框渲染：content + prepared.patch → pairs → 每个修改点首行的 hunkIdx/changeIdx
    const content = read(file);
    const pairs = buildFullFileDiff(content, prepared.patch);
    const changeStarts = pairs
      .filter((p) => p.changeStart)
      .map((p) => [p.hunkIdx, p.changeIdx]);
    expect(changeStarts).toEqual([[0, 0], [1, 0]]);

    // 点击第 2 个 hunk 的「撤销」
    const result = await service.apply(state.transactionId, state.version, {
      kind: "hunk",
      file: sourceFiles[0].file,
      hunkIndex: 1,
      changeIndex: 0,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const after = read(file).split("\n");
    // 被撤销的 hunk 恢复原文，其余 hunk 保留
    expect(after[2]).toBe("line 3 EDITED");
    expect(after[25]).toBe("line 26");
    expect(read(file)).not.toContain("line 26 EDITED");
    expect(read(file)).toContain("line 3 EDITED");
  });
});
