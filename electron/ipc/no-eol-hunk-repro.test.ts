import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewUndoService } from "./rebuild-file";
import { TurnFileDiffTracker } from "../plugin-runtime/turn-file-diff";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const createRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-noeol-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
  return dir;
};
const createService = () => {
  const root = mkdtempSync(join(tmpdir(), "hpp-noeol-state-"));
  tempDirs.push(root);
  return new ReviewUndoService({ stateRoot: join(root, "state"), backupRoot: join(root, "backups") });
};
const read = (file: string) => readFileSync(file, "utf8");

describe("no-EOL file partial undo (user test.txt scenario)", () => {
  it("undoes a hunk of a no-trailing-newline file with stacked cumulative patches", async () => {
    const dir = createRepo();
    const service = createService();
    const file = join(dir, "test.txt");
    const base = Array.from({ length: 20 }, (_, i) => `第${String(i + 1).padStart(2, "0")}行：原始内容${i + 1}`).join("\n");
    writeFileSync(file, base, "utf8"); // 无结尾换行
    execFileSync("git", ["add", "--all"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: dir });

    const tracker = new TurnFileDiffTracker();
    tracker.capture(dir, "test.txt");
    const patches: string[] = [];
    const current = base.split("\n");
    // 模拟用户的多轮修改：前面区域 + 末尾区域（末尾即 no-EOL 标记所在行）
    const rounds: Array<[number, string]> = [
      [2, "第03行：改动一"],
      [9, "第10行：改动二"],
      [19, "第20行：区域B已修改"],
    ];
    for (const [idx, value] of rounds) {
      current[idx] = value;
      writeFileSync(file, current.join("\n"), "utf8");
      const computed = tracker.resolve(dir, "test.txt");
      expect(computed).not.toBeNull();
      if (!computed) return;
      patches.push(computed.patch);
    }

    const prep = await service.prepare({
      reviewId: "msg-1",
      projectPath: dir,
      files: [{ file: "test.txt", patches, status: "modified" }],
    });
    expect(prep.success).toBe(true);
    if (!prep.success) return;
    const state = prep.state;
    expect(state.files[0].undoable).toBe(true);
    expect(state.files[0].hunkCount).toBeGreaterThanOrEqual(2);

    // 先撤销 hunk 0 内的第二个修改点（第 10 行改动，hunk 0 含第 3、10 两处合并修改）
    const changeUndo = await service.apply(state.transactionId, state.version, {
      kind: "hunk", file: "test.txt", hunkIndex: 0, changeIndex: 1,
    });
    expect(changeUndo.success).toBe(true);
    if (!changeUndo.success) return;
    const partial = read(file);
    expect(partial).toContain("改动一");
    expect(partial).toContain("第10行：原始内容10");
    expect(partial).toContain("区域B已修改"); // 末尾 hunk 未动
    expect(partial.endsWith("\n")).toBe(false); // 无结尾换行保持

    // 再撤销末尾 hunk（含 no-EOL 标记的那一段）
    const hunkCount = changeUndo.state.files[0].hunkCount;
    const result = await service.apply(changeUndo.state.transactionId, changeUndo.state.version, {
      kind: "hunk", file: "test.txt", hunkIndex: hunkCount - 1,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const after = read(file);
    expect(after).toContain("改动一"); // 未撤销
    expect(after).not.toContain("改动二"); // 第一步已撤销
    expect(after).not.toContain("区域B已修改"); // 已撤销
    expect(after.endsWith("\n")).toBe(false); // 保持无结尾换行
    expect(after).toContain("第20行：原始内容20");
  });
});
