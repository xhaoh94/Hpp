import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";
import { createInterface } from "readline";

export interface CodexHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  nativeTurnId?: string;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const getTimestamp = (value: unknown): number => {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
};

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function resolveCodexHistoryFile(
  sessionReference: string,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
): Promise<string | null> {
  if (!sessionReference) return null;
  if (await isFile(sessionReference)) return sessionReference;

  const sessionId = basename(sessionReference).replace(/\.jsonl$/i, "");
  if (sessionId.length < 8) return null;

  const pendingDirectories = [join(codexHome, "sessions")];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        (entry.name === `${sessionId}.jsonl` || entry.name.endsWith(`-${sessionId}.jsonl`))
      ) {
        return entryPath;
      }
    }
  }

  return null;
}

export async function parseCodexHistoryFile(filePath: string): Promise<CodexHistoryMessage[]> {
  const messages: CodexHistoryMessage[] = [];
  const finalAnswers = new Map<string, { content: string; timestamp: number }>();
  const consumedFinalAnswers = new Set<string>();
  let currentTurnId: string | undefined;
  let messageIndex = 0;

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: UnknownRecord;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }

    if (record.type !== "event_msg" || !isRecord(record.payload)) continue;
    const payload = record.payload;
    const timestamp = getTimestamp(record.timestamp);
    const payloadTurnId = getString(payload.turn_id);

    if (payload.type === "task_started") {
      currentTurnId = payloadTurnId;
      continue;
    }

    if (payload.type === "user_message") {
      const content = getString(payload.message);
      if (!content) continue;
      const clientId = getString(payload.client_id);
      messageIndex += 1;
      messages.push({
        id: `codex-history-user-${clientId || currentTurnId || messageIndex}-${messageIndex}`,
        role: "user",
        content,
        timestamp,
        nativeTurnId: currentTurnId,
      });
      continue;
    }

    if (payload.type === "agent_message" && payload.phase === "final_answer") {
      const content = getString(payload.message);
      if (content) {
        finalAnswers.set(payloadTurnId || currentTurnId || `unscoped-${messageIndex}`, { content, timestamp });
      }
      continue;
    }

    if (payload.type === "task_complete") {
      const turnId = payloadTurnId || currentTurnId || `unscoped-${messageIndex}`;
      const fallback = finalAnswers.get(turnId);
      const content = getString(payload.last_agent_message) || fallback?.content;
      if (content) {
        messageIndex += 1;
        messages.push({
          id: `codex-history-assistant-${turnId}-${messageIndex}`,
          role: "assistant",
          content,
          timestamp: fallback?.timestamp || timestamp,
          nativeTurnId: payloadTurnId || currentTurnId,
        });
        consumedFinalAnswers.add(turnId);
      }
      currentTurnId = undefined;
    }
  }

  for (const [turnId, answer] of finalAnswers) {
    if (consumedFinalAnswers.has(turnId)) continue;
    messageIndex += 1;
    messages.push({
      id: `codex-history-assistant-${turnId}-${messageIndex}`,
      role: "assistant",
      content: answer.content,
      timestamp: answer.timestamp,
      nativeTurnId: turnId.startsWith("unscoped-") ? undefined : turnId,
    });
  }

  return messages.sort((left, right) => left.timestamp - right.timestamp);
}

export async function loadCodexHistorySnapshot(sessionReference: string): Promise<CodexHistoryMessage[]> {
  const filePath = await resolveCodexHistoryFile(sessionReference);
  return filePath ? parseCodexHistoryFile(filePath) : [];
}
