import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const taskIdPattern = /^(?:sa|w)_[a-z0-9]+(?:-r\d+)?$/;

/** 独立记录使不同任务的更新互不覆盖。只按本会话的任务 ID 查盘。 */
export function createSubagentStorage(root, sessionKey) {
  const segment = String(sessionKey || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const directory = root && join(root, !segment || /^\.+$/.test(segment) ? "default" : segment);
  const pathFor = (id, suffix) => directory && taskIdPattern.test(id) ? join(directory, id + suffix) : "";

  function write(id, suffix, data) {
    const path = pathFor(id, suffix);
    if (!path) return;
    const temp = path + "." + randomUUID() + ".tmp";
    try {
      if (!data) { rmSync(path, { force: true }); return; }
      mkdirSync(directory, { recursive: true });
      writeFileSync(temp, JSON.stringify({ version: 1, ...data }), { mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      console.warn("[hpp-pi] 无法保存子任务状态", id, error.message);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }

  function read(id, suffix) {
    const path = pathFor(id, suffix);
    if (!path || !existsSync(path)) return;
    try {
      const item = JSON.parse(readFileSync(path, "utf8"));
      if (item.version === 1 && item.id === id) return item;
    } catch (error) { console.warn("[hpp-pi] 无法读取子任务状态", id, error.message); }
  }

  function loadTask(id) {
    const metadata = read(id, ".task.json");
    if (metadata) return metadata;
    // 旧版只写 Markdown 结果与 JSONL 会话。按原 ID 恢复已结束的普通任务。
    const resultFile = pathFor(id, ".result.md");
    if (!resultFile || !existsSync(resultFile)) return;
    try {
      const body = readFileSync(resultFile, "utf8");
      const match = /^# ([\s\S]*?)\r?\n- id: ([^\r\n]+)\r?\n- agent: ([^\r\n]+)\r?\n- model: ([^\r\n]+)\r?\n- status: (completed|error|interrupted)\r?\n- startedAt: ([^\r\n]+)\r?\n(?:- completedAt: ([^\r\n]+)\r?\n)?\r?\n([\s\S]*)$/.exec(body);
      if (!match || match[2] !== id) return;
      const [, task, , agent, model, status, start, end, output] = match;
      return {
        id, task, agent, model: model === "(默认)" ? undefined : model, status,
        kind: agent === "chain" ? "chain" : "single", agentScope: "user",
        sessionFile: pathFor(id, ".jsonl"), resultFile, startedAt: Date.parse(start),
        completedAt: Date.parse(end || start), rounds: [{}], toolCallId: id,
        result: { agent, task, output, exitCode: status === "completed" ? 0 : 1 },
      };
    } catch { return; }
  }

  return {
    directory, loadTask,
    saveTask(entry, result) {
      const { id, agent, agentScope, agentPinnedModel, projectAgentsDir, projectPath, task, lastTask,
        title, model, cwd, isolation, todoId, inheritContext, kind, step, timeoutMs, sessionFile,
        resultFile, startedAt, completedAt, lastActivityAt, status, rounds, usage, lastRoundUsage,
        toolCallId, worktree } = entry;
      write(id, ".task.json", { id, agent, agentScope, agentPinnedModel, projectAgentsDir, projectPath,
        task, lastTask, title, model, cwd, isolation, todoId, inheritContext, kind, step, timeoutMs,
        sessionFile, resultFile, startedAt, completedAt, lastActivityAt, status, rounds, usage,
        lastRoundUsage, toolCallId, worktree, result });
    },
    loadIsolation: (id) => read(id, ".worktree.json"),
    saveIsolation: (id, item) => write(id, ".worktree.json", item),
  };
}
