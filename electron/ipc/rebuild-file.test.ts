import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PrepareReviewUndoRequest,
  ReviewUndoState,
} from "../../shared/review-undo";
import { ReviewUndoService } from "./rebuild-file";
import { TurnFileDiffTracker } from "../plugin-runtime/turn-file-diff";

const tempDirs: string[] = [];

const createRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-review-undo-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Hpp Test"], { cwd: dir });
  return dir;
};

const createService = (root?: string) => {
  const serviceRoot = root || mkdtempSync(join(tmpdir(), "hpp-review-state-test-"));
  if (!root) tempDirs.push(serviceRoot);
  return {
    root: serviceRoot,
    service: new ReviewUndoService({
      stateRoot: join(serviceRoot, "state"),
      backupRoot: join(serviceRoot, "backups"),
    }),
  };
};

const commit = (dir: string, message: string) => {
  execFileSync("git", ["add", "--all"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
};

const diff = (dir: string, ...args: string[]) => execFileSync(
  "git",
  ["diff", "--no-ext-diff", ...args],
  { cwd: dir, encoding: "utf8" },
);

const writeLines = (file: string, lines: string[]) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
};

const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const prepare = async (
  service: ReviewUndoService,
  projectPath: string,
  files: PrepareReviewUndoRequest["files"],
  reviewId = "message-1",
): Promise<ReviewUndoState> => {
  const result = await service.prepare({ reviewId, projectPath, files });
  if (!result.success) throw new Error(result.error);
  return result.state;
};

const apply = async (
  service: ReviewUndoService,
  state: ReviewUndoState,
  target: Parameters<ReviewUndoService["apply"]>[2],
) => service.apply(state.transactionId, state.version, target);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ReviewUndoService", () => {
  it("undoes independent final hunks and restores state after remount", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { root, service } = createService();
    const file = join(dir, "a.txt");
    const base = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
    writeLines(file, base);
    commit(dir, "base");

    const edited = [...base];
    edited[0] = "line1-A";
    edited[19] = "line20-B";
    writeLines(file, edited);
    const patch = diff(dir);
    const files = [{ file: "a.txt", patches: [patch], status: "modified" }];

    const initial = await prepare(service, dir, files);
    expect(initial.files[0]).toMatchObject({ hunkCount: 2, undoable: true });

    const first = await apply(service, initial, { kind: "hunk", file: "a.txt", hunkIndex: 0 });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const afterFirst = [...base];
    afterFirst[19] = "line20-B";
    expect(read(file)).toBe(`${afterFirst.join("\n")}\n`);
    expect(first.state.files[0]).toMatchObject({ hunkCount: 1, additions: 1, deletions: 1 });

    const remounted = await prepare(new ReviewUndoService({
      stateRoot: join(root, "state"),
      backupRoot: join(root, "backups"),
    }), dir, files);
    expect(remounted.version).toBe(1);
    expect(remounted.files[0]).toMatchObject({ hunkCount: 1, undoable: true });

    const second = await apply(service, remounted, { kind: "hunk", file: "a.txt", hunkIndex: 0 });
    expect(second.success).toBe(true);
    expect(read(file)).toBe(`${base.join("\n")}\n`);
  });

  it("folds cumulative snapshots into one verified final diff", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    const base = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
    writeLines(file, base);
    commit(dir, "base");

    const firstEdit = [...base];
    firstEdit[0] = "line1-A";
    writeLines(file, firstEdit);
    const firstSnapshot = diff(dir);

    const finalEdit = [...firstEdit];
    finalEdit[19] = "line20-B";
    writeLines(file, finalEdit);
    const cumulativeSnapshot = diff(dir);

    const state = await prepare(service, dir, [{
      file: "a.txt",
      patches: [firstSnapshot, cumulativeSnapshot],
      status: "modified",
    }]);
    expect(state.files[0].hunkCount).toBe(2);

    const result = await apply(service, state, { kind: "file", file: "a.txt" });
    expect(result.success).toBe(true);
    expect(read(file)).toBe(`${base.join("\n")}\n`);
  });

  it("does not reverse a covered stale patch into duplicate text", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    const base = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
    base[0] = "old";
    base[9] = "new";
    writeLines(file, base);
    commit(dir, "base");

    const firstEdit = [...base];
    firstEdit[0] = "new";
    writeLines(file, firstEdit);
    const stalePatch = diff(dir, "-U0", "--", "a.txt");

    const finalEdit = [...firstEdit];
    finalEdit[19] = "line20-B";
    writeLines(file, finalEdit);
    const cumulative = diff(dir, "--", "a.txt");

    const state = await prepare(service, dir, [{
      file: "a.txt",
      patches: [stalePatch, cumulative],
    }]);
    expect(state.files[0].undoable).toBe(true);
    const result = await apply(service, state, { kind: "file", file: "a.txt" });
    expect(result.success).toBe(true);
    expect(read(file)).toBe(`${base.join("\n")}\n`);
  });

  it("collapses dependent edits to the same line into one undoable final hunk", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    writeLines(file, ["old", "keep"]);
    commit(dir, "base");

    writeLines(file, ["mid", "keep"]);
    const firstPatch = diff(dir);
    commit(dir, "first edit");
    writeLines(file, ["new", "keep"]);
    const secondPatch = diff(dir);

    const state = await prepare(service, dir, [{
      file: "a.txt",
      patches: [firstPatch, secondPatch],
      status: "modified",
    }]);
    expect(state.files[0]).toMatchObject({ hunkCount: 1, additions: 1, deletions: 1 });

    const result = await apply(service, state, { kind: "hunk", file: "a.txt", hunkIndex: 0 });
    expect(result.success).toBe(true);
    expect(read(file)).toBe("old\nkeep\n");
  });

  it("synthesizes safe file headers for a headerless structured patch", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    writeLines(file, ["old", "keep"]);
    commit(dir, "base");
    writeLines(file, ["new", "keep"]);
    const headerless = [
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " keep",
    ].join("\n");

    const state = await prepare(service, dir, [{
      file: "a.txt",
      patches: [headerless],
      status: "modified",
    }]);
    expect(state.files[0]).toMatchObject({ undoable: true, hunkCount: 1 });

    const result = await apply(service, state, { kind: "hunk", file: "a.txt", hunkIndex: 0 });
    expect(result.success).toBe(true);
    expect(read(file)).toBe("old\nkeep\n");
  });

  it("produces an undoable chain when prompt and guidance edit the same file", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "same.ts");
    writeLines(file, ["old"]);
    commit(dir, "base");
    writeLines(file, ["middle"]);
    const first = diff(dir, "--", "same.ts");
    commit(dir, "middle");
    writeLines(file, ["new"]);
    const second = diff(dir, "--", "same.ts");

    const state = await prepare(service, dir, [{
      file: "same.ts",
      patches: [first, second],
      status: "modified",
      statusExplicit: false,
    }]);
    expect(state.files[0]).toMatchObject({ undoable: true, additions: 1, deletions: 1 });
    const result = await apply(service, state, { kind: "file", file: "same.ts" });
    expect(result.success).toBe(true);
    expect(read(file)).toBe("old\n");
  });

  it("rejects an ambiguous headerless whole-file addition without an added status", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "ambiguous.txt");
    writeLines(file, ["created"]);
    const state = await prepare(service, dir, [{
      file: "ambiguous.txt",
      patches: ["@@ -0,0 +1,1 @@\n+created"],
      status: "modified",
    }]);
    expect(state.files[0].undoable).toBe(false);
    expect(state.files[0].error).toContain("无法确认文件原本是否存在");
    expect(read(file)).toBe("created\n");
  });

  it("loads only an existing persisted transaction", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    writeLines(file, ["old"]);
    commit(dir, "base");
    writeLines(file, ["new"]);
    const request = {
      reviewId: "persisted-load",
      projectPath: dir,
      files: [{ file: "a.txt", patches: [diff(dir)] }],
    };

    expect(await service.load(request)).toEqual({ success: true, state: null });
    const prepared = await service.prepare(request);
    expect(prepared.success).toBe(true);
    const loaded = await service.load(request);
    expect(loaded.success).toBe(true);
    if (!loaded.success) return;
    expect(loaded.state?.transactionId).toBe(prepared.success ? prepared.state.transactionId : "");
  });

  it("supports paths containing spaces and non-ASCII characters", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const relativePath = "目录/a space 中文.txt";
    const file = join(dir, relativePath);
    writeLines(file, ["old", "keep"]);
    commit(dir, "base");
    writeLines(file, ["new", "keep"]);
    const patch = diff(dir, "--", relativePath);

    const state = await prepare(service, dir, [{ file: relativePath, patches: [patch] }]);
    expect(state.files[0]).toMatchObject({ undoable: true, hunkCount: 1 });
    const result = await apply(service, state, {
      kind: "hunk",
      file: relativePath,
      hunkIndex: 0,
    });
    expect(result.success).toBe(true);
    expect(read(file)).toBe("old\nkeep\n");
  });

  it("rejects rename patches without touching either path", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const oldFile = join(dir, "old.txt");
    const newFile = join(dir, "new.txt");
    writeLines(oldFile, Array.from({ length: 20 }, (_, index) => `line${index + 1}`));
    commit(dir, "base");
    execFileSync("git", ["mv", "old.txt", "new.txt"], { cwd: dir });
    const lines = read(newFile).trimEnd().split("\n");
    lines[9] = "changed";
    writeLines(newFile, lines);
    const patch = diff(dir, "HEAD", "--find-renames");

    const state = await prepare(service, dir, [{ file: "new.txt", patches: [patch] }]);
    expect(state.files[0].undoable).toBe(false);
    expect(state.files[0].error).toContain("重命名");
    expect(state.canUndoAll).toBe(false);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("rejects a patch containing multiple files", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    writeLines(join(dir, "a.txt"), ["a"]);
    writeLines(join(dir, "b.txt"), ["b"]);
    commit(dir, "base");
    writeLines(join(dir, "a.txt"), ["a-edit"]);
    writeLines(join(dir, "b.txt"), ["b-edit"]);
    const patch = diff(dir);

    const state = await prepare(service, dir, [{ file: "a.txt", patches: [patch] }]);
    expect(state.files[0].undoable).toBe(false);
    expect(state.files[0].error).toContain("多个文件");
    expect(read(join(dir, "a.txt"))).toBe("a-edit\n");
    expect(read(join(dir, "b.txt"))).toBe("b-edit\n");
  });

  it("serializes concurrent requests and rejects the stale version", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    const base = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
    writeLines(file, base);
    commit(dir, "base");
    const edited = [...base];
    edited[0] = "line1-A";
    edited[19] = "line20-B";
    writeLines(file, edited);
    const state = await prepare(service, dir, [{ file: "a.txt", patches: [diff(dir)] }]);

    const [first, second] = await Promise.all([
      apply(service, state, { kind: "hunk", file: "a.txt", hunkIndex: 0 }),
      apply(service, state, { kind: "hunk", file: "a.txt", hunkIndex: 1 }),
    ]);
    expect(first.success).toBe(true);
    expect(second).toMatchObject({ success: false, stale: true });
    const expected = [...base];
    expected[19] = "line20-B";
    expect(read(file)).toBe(`${expected.join("\n")}\n`);
  });

  it("undoes a single change point inside a merged hunk", { timeout: 30000 }, async () => {
    // 复刻用户实测场景：三处单行修改间距 4 行，git 用 3 行上下文把
    // 它们合并成一个 hunk；撤销按钮按修改点渲染，必须能只回退其中一处。
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "test.txt");
    const base = Array.from({ length: 20 }, (_, index) => `第${String(index + 1).padStart(2, "0")}行：原始`);
    writeLines(file, base);
    commit(dir, "base");
    const edited = [...base];
    edited[2] = "第03行：改动一";
    edited[7] = "第08行：改动二";
    edited[12] = "第13行：改动三";
    writeLines(file, edited);
    const patch = diff(dir, "--", "test.txt");
    expect(patch.match(/^@@/gm)).toHaveLength(1); // 确实被合并成一个 hunk

    const state = await prepare(service, dir, [{ file: "test.txt", patches: [patch] }]);

    // 三个修改点各自可撤销，且只影响自己那一行。
    const undoSecond = await apply(service, state, {
      kind: "hunk", file: "test.txt", hunkIndex: 0, changeIndex: 1,
    });
    expect(undoSecond.success).toBe(true);
    if (!undoSecond.success) return;
    expect(read(file).split("\n")).toEqual([
      ...base.slice(0, 2),
      "第03行：改动一",
      ...base.slice(3, 7),
      "第08行：原始",
      ...base.slice(8, 12),
      "第13行：改动三",
      ...base.slice(13),
      "",
    ]);

    // 撤销第一个修改点后，其余修改点序号前移但内容保持可定位。
    const undoFirst = await apply(service, undoSecond.state, {
      kind: "hunk", file: "test.txt", hunkIndex: 0, changeIndex: 0,
    });
    expect(undoFirst.success).toBe(true);
    if (!undoFirst.success) return;
    expect(read(file)).toContain("第03行：原始");
    expect(read(file)).toContain("第13行：改动三");

    // 越界的修改点序号报错而不是误伤其他行。
    const outOfRange = await apply(service, undoFirst.state, {
      kind: "hunk", file: "test.txt", hunkIndex: 0, changeIndex: 5,
    });
    expect(outOfRange.success).toBe(false);
    expect(read(file)).toContain("第13行：改动三");
  });

  it("unifies partial, file, and all undo in one transaction", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    const baseA = Array.from({ length: 20 }, (_, index) => `a${index + 1}`);
    const baseB = ["b1", "b2"];
    writeLines(a, baseA);
    writeLines(b, baseB);
    commit(dir, "base");
    const editedA = [...baseA];
    editedA[0] = "a1-edit";
    editedA[19] = "a20-edit";
    writeLines(a, editedA);
    writeLines(b, ["b1-edit", "b2"]);
    const combined = diff(dir);
    const aPatch = diff(dir, "--", "a.txt");
    const bPatch = diff(dir, "--", "b.txt");
    expect(combined).toContain("a.txt");

    const state = await prepare(service, dir, [
      { file: "a.txt", patches: [aPatch] },
      { file: "b.txt", patches: [bPatch] },
    ]);
    const partial = await apply(service, state, { kind: "hunk", file: "a.txt", hunkIndex: 0 });
    expect(partial.success).toBe(true);
    if (!partial.success) return;

    const all = await apply(service, partial.state, { kind: "all" });
    expect(all.success).toBe(true);
    if (!all.success) return;
    expect(all.state.allReverted).toBe(true);
    expect(read(a)).toBe(`${baseA.join("\n")}\n`);
    expect(read(b)).toBe(`${baseB.join("\n")}\n`);
  });

  it("preserves an external edit made after preparation", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    writeLines(file, ["old", "keep"]);
    commit(dir, "base");
    writeLines(file, ["agent", "keep"]);
    const state = await prepare(service, dir, [{ file: "a.txt", patches: [diff(dir)] }]);

    writeLines(file, ["external", "keep"]);
    const result = await apply(service, state, { kind: "file", file: "a.txt" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("审核撤销之外");
    expect(read(file)).toBe("external\nkeep\n");
  });

  it("backs up the pre-operation content before an atomic write", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    writeLines(file, ["old", "keep"]);
    commit(dir, "base");
    writeLines(file, ["new", "keep"]);
    const state = await prepare(service, dir, [{ file: "a.txt", patches: [diff(dir)] }]);

    const result = await apply(service, state, { kind: "file", file: "a.txt" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.backupPath).toBeTruthy();
    expect(read(join(result.backupPath as string, "a.txt"))).toBe("new\nkeep\n");
    expect(read(file)).toBe("old\nkeep\n");
  });

  it("handles added, deleted, and empty added files", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const deleted = join(dir, "deleted.txt");
    writeLines(deleted, ["restore me"]);
    commit(dir, "base");

    const added = join(dir, "added.txt");
    writeLines(added, ["remove me"]);
    execFileSync("git", ["add", "-N", "added.txt"], { cwd: dir });
    const addedPatch = diff(dir, "--", "added.txt");

    rmSync(deleted);
    const deletedPatch = diff(dir, "--", "deleted.txt");

    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "");
    execFileSync("git", ["add", "-N", "empty.txt"], { cwd: dir });
    const emptyPatch = diff(dir, "--", "empty.txt");

    const state = await prepare(service, dir, [
      { file: "added.txt", patches: [addedPatch], status: "added" },
      { file: "deleted.txt", patches: [deletedPatch], status: "deleted" },
      { file: "empty.txt", patches: [emptyPatch], status: "added" },
    ]);
    expect(state.files.every((fileState) => !fileState.error)).toBe(true);

    const result = await apply(service, state, { kind: "all" });
    expect(result.success).toBe(true);
    expect(existsSync(added)).toBe(false);
    expect(existsSync(empty)).toBe(false);
    expect(read(deleted)).toBe("restore me\n");
  });

  it("rejects a metadata-only empty-file patch for another path", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "target.txt");
    writeFileSync(file, "");
    const mismatchedPatch = [
      "diff --git a/other.txt b/other.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
    ].join("\n");
    const state = await prepare(service, dir, [{
      file: "target.txt",
      patches: [mismatchedPatch],
      status: "added",
      statusExplicit: true,
    }]);
    expect(state.files[0].undoable).toBe(false);
    expect(state.files[0].error).toContain("目标文件之外");
    expect(existsSync(file)).toBe(true);
  });

  it("rejects targets outside the project", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const outside = createRepo();
    const { service } = createService();
    const outsideFile = join(outside, "outside.txt");
    writeLines(outsideFile, ["changed"]);

    const result = await service.prepare({
      reviewId: "outside",
      projectPath: dir,
      files: [{
        file: outsideFile,
        patches: ["@@ -1 +1 @@\n-old\n+changed"],
      }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("outside the project");
    expect(read(outsideFile)).toBe("changed\n");
  });

  // provider 只回报「文件路径 + modified」却不带 patch 时，后端会在工具执行前
  // 抓快照、执行后自算差异。这里端到端验证：那套自算补丁必须能被撤销引擎
  // 真正消费，而不是像空补丁那样只能拒绝。
  it("undoes a change whose patch came from the tool-event fallback", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "test.txt");
    const base = Array.from({ length: 10 }, (_, index) => `第${String(index + 1).padStart(2, "0")}行`);
    writeLines(file, base);
    commit(dir, "base");

    const tracker = new TurnFileDiffTracker();
    // 模拟 tool_start：工具执行前抓快照
    tracker.capture(dir, "test.txt");

    const edited = [...base];
    edited[4] = "第05行：又一次测试改动";
    writeLines(file, edited);

    const computed = tracker.resolve(dir, "test.txt");
    expect(computed).not.toBeNull();
    if (!computed) return;
    expect(computed).toMatchObject({ file: "test.txt", additions: 1, deletions: 1, status: "modified" });

    const state = await prepare(service, dir, [{
      file: computed.file,
      patches: [computed.patch],
      status: computed.status,
      statusExplicit: computed.statusExplicit,
    }]);
    expect(state.files[0].undoable).toBe(true);

    const result = await apply(service, state, { kind: "file", file: "test.txt" });
    expect(result.success).toBe(true);
    expect(read(file)).toBe(`${base.join("\n")}\n`);
  });

  it("undoes a hunk from a fallback-computed patch", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "multi.txt");
    const base = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
    writeLines(file, base);
    commit(dir, "base");

    const tracker = new TurnFileDiffTracker();
    tracker.capture(dir, "multi.txt");

    const edited = [...base];
    edited[0] = "line1-A";
    edited[19] = "line20-B";
    writeLines(file, edited);

    const computed = tracker.resolve(dir, "multi.txt");
    expect(computed).not.toBeNull();
    if (!computed) return;

    const state = await prepare(service, dir, [{
      file: computed.file,
      patches: [computed.patch],
      status: computed.status,
      statusExplicit: computed.statusExplicit,
    }]);
    expect(state.files[0].hunkCount).toBe(2);

    // 只撤销第二段，第一段必须保留
    const result = await apply(service, state, { kind: "hunk", file: "multi.txt", hunkIndex: 1 });
    expect(result.success).toBe(true);
    const expected = [...base];
    expected[0] = "line1-A";
    expect(read(file)).toBe(`${expected.join("\n")}\n`);
  });

  // 「审核弹窗说无法撤销」的真实成因：provider 的补丁基于过期上下文，看着有
  // 正常的 +/- 行，正反向却都 apply 不上。这里先复现故障，再证明换成自算兜底
  // 后能正常撤销——这正是兜底优先级排在 provider 补丁前面的理由。
  it("rejects a stale provider patch but accepts the computed fallback", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "a.txt");
    const base = ["line1", "line2", "line3", "line4", "line5"];
    writeLines(file, base);
    commit(dir, "base");

    const tracker = new TurnFileDiffTracker();
    tracker.capture(dir, "a.txt");

    const edited = [...base];
    edited[1] = "line2-changed";
    writeLines(file, edited);

    const computed = tracker.resolve(dir, "a.txt");
    expect(computed).not.toBeNull();
    if (!computed) return;

    // provider 给的补丁上下文与磁盘内容对不上：正反向都 apply 不了
    const stalePatch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      "-过期上文",
      "-过期本行",
      "-过期下文",
      "+新上文",
      "+新本行",
      "+新下文",
    ].join("\n");

    // 只用 provider 补丁 —— 复现「无法安全撤销」
    const staleState = await prepare(service, dir, [{
      file: "a.txt",
      patches: [stalePatch],
      status: "modified",
    }]);
    expect(staleState.files[0].undoable).toBe(false);
    expect(staleState.files[0].error).toBeTruthy();

    // 换成自算兜底 —— 同一份改动就能正常撤销
    const state = await prepare(service, dir, [{
      file: computed.file,
      patches: [computed.patch],
      status: computed.status,
      statusExplicit: computed.statusExplicit,
    }]);
    expect(state.files[0].undoable).toBe(true);

    const result = await apply(service, state, { kind: "file", file: "a.txt" });
    expect(result.success).toBe(true);
    expect(read(file)).toBe(`${base.join("\n")}\n`);
  });

  // 用户真实故障的完整复现：Windows CRLF 文件连续 4 次编辑，前端把每份
  // 「本轮起点 → 当前磁盘」的累计补丁都堆进 msg.diffs（4 份），且旧实现
  // 生成补丁时把 \r 洗掉 + trimEnd 剥掉末行 \r，导致 4 份补丁正反向全部
  // "patch failed: test.txt:4 ... patch does not apply"。这里用真实 tracker
  // 产出 4 份字节精确的累计补丁，验证撤销引擎即使收到 4 份也能选中可用的
  // 那份并逐字节还原 CRLF 原文。
  it("undoes a CRLF file with four stacked cumulative patches (user regression)", { timeout: 30000 }, async () => {
    const dir = createRepo();
    const { service } = createService();
    const file = join(dir, "test.txt");
    const base = ["第一行", "第二行", "第三行", "第四行原始", "第五行", "第六行", "第七行"];
    const raw = (lines: string[]) => `${lines.join("\r\n")}\r\n`;
    writeFileSync(file, raw(base), "utf8");
    commit(dir, "base");

    const tracker = new TurnFileDiffTracker();
    // 只 capture 一次：baseline 永远是本轮起点（与真实 tool_start 行为一致）
    tracker.capture(dir, "test.txt");

    const patches: string[] = [];
    const current = [...base];
    for (let round = 1; round <= 4; round++) {
      current[3] = `第四行第${round}次修改`;
      if (round === 4) current[5] = "第六行附带修改";
      writeFileSync(file, raw(current), "utf8");
      const computed = tracker.resolve(dir, "test.txt");
      expect(computed).not.toBeNull();
      if (!computed) return;
      // 字节精确性：CRLF 文件的补丁上下文行必须保留 \r，否则 git apply 必败
      expect(computed.patch).toContain("\r");
      patches.push(computed.patch);
    }
    expect(patches).toHaveLength(4);

    // 模拟旧前端行为：4 份累计补丁全部传给 prepare
    const state = await prepare(service, dir, [{
      file: "test.txt",
      patches,
      status: "modified",
    }]);
    expect(state.files[0].undoable).toBe(true);

    const result = await apply(service, state, { kind: "file", file: "test.txt" });
    expect(result.success).toBe(true);
    // 逐字节断言（readFileSync 原样读，不经 read() 的 CRLF 归一化）
    expect(readFileSync(file, "utf8")).toBe(raw(base));
  });
});
