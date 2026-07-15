import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexHistoryFile, resolveCodexHistoryFile } from "./history";

describe("Codex history recovery", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("recovers user messages and final answers without commentary", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-codex-history-"));
    tempRoots.push(root);
    const filePath = join(root, "session.jsonl");
    const records = [
      { timestamp: "2026-07-13T01:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: "2026-07-13T01:00:01.000Z", type: "event_msg", payload: { type: "user_message", client_id: "user-1", message: "hello" } },
      { timestamp: "2026-07-13T01:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "working" } },
      { timestamp: "2026-07-13T01:00:03.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "done" } },
      { timestamp: "2026-07-13T01:00:04.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" } },
    ];
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

    const messages = await parseCodexHistoryFile(filePath);

    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "done" },
    ]);
    expect(messages.every((message) => message.nativeTurnId === "turn-1")).toBe(true);
  });

  it("finds a native session file by thread id", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-codex-home-"));
    tempRoots.push(root);
    const sessionDirectory = join(root, "sessions", "2026", "07", "13");
    await mkdir(sessionDirectory, { recursive: true });
    const filePath = join(sessionDirectory, "rollout-2026-07-13T10-00-00-thread-12345678.jsonl");
    await writeFile(filePath, "", "utf8");

    await expect(resolveCodexHistoryFile("thread-12345678", root)).resolves.toBe(filePath);
  });
});
