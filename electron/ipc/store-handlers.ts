import { ipcMain } from "electron";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync } from "fs";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { app } from "electron";
import type { SessionDataPurgeRequest } from "../../src/types/ipc";

const dataDir = join(app.getPath("userData"), "hpp-data");
const ALLOWED_STORE_KEYS = new Set(["settings", "projects", "currentModel", "editor"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SESSION_MESSAGES_DB_PATH = join(dataDir, "session-messages.sqlite");
/** 旧版把全部会话消息放在这一个 JSON 里，SQLite 上线后只用于一次性导入。 */
const LEGACY_SESSION_MESSAGES_JSON_PATH = join(dataDir, "sessionMessages.json");
/** freelist 占比达到该值且空闲页够多时才做 VACUUM（它会阻塞主进程并需要约两倍临时空间）。 */
const VACUUM_MIN_FREE_PAGES = 64;
const VACUUM_FREE_PAGE_RATIO = 0.2;
const storeWriteQueues = new Map<string, Promise<void>>();
let sessionMessagesDb: DatabaseSync | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeIds = (value: unknown) => new Set(
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
    : [],
);

function getStoreFilePath(key: unknown): string {
  if (typeof key !== "string" || !ALLOWED_STORE_KEYS.has(key)) {
    throw new Error("Invalid data store key.");
  }
  return join(dataDir, `${key}.json`);
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error("Invalid session ID.");
  }
  return value;
}

function getSessionMessagesDb(): DatabaseSync {
  if (sessionMessagesDb) return sessionMessagesDb;
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(SESSION_MESSAGES_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS session_message_rows (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_message_rows_order
      ON session_message_rows (session_id, sequence);
    CREATE TABLE IF NOT EXISTS session_message_sessions (
      session_id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );
  `);
  sessionMessagesDb = db;
  importLegacySessionMessages(db);
  return db;
}

/** 旧 JSON 里的消息要能过渲染层的 parsePersistedChatMessage，否则导进来也渲染不出来。 */
function isImportableLegacyMessage(value: unknown): value is { id: string } {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") return false;
  return typeof value.content === "string" && typeof value.timestamp === "number" && value.timestamp > 0;
}

function archiveLegacySessionMessagesJson(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", ".bak"]) {
    const source = `${LEGACY_SESSION_MESSAGES_JSON_PATH}${suffix}`;
    try {
      renameSync(source, `${source}.imported-${stamp}`);
    } catch {
      // 文件不存在或已被归档。
    }
  }
}

/**
 * SQLite 成为消息的唯一来源后，升级用户的历史只存在于旧的 sessionMessages.json 里：
 * 不做这一步，那些消息既读不到，也不会被任何清理路径回收（purge 只处理 projects/currentModel）。
 * 只导入 SQLite 里还没有记录的会话，成功后把源文件改名归档，保证幂等。
 */
function importLegacySessionMessages(db: DatabaseSync): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(LEGACY_SESSION_MESSAGES_JSON_PATH, "utf-8"));
  } catch {
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.sessionMessages)) return;

  const sessions = Object.entries(parsed.sessionMessages).flatMap(([sessionId, messages]) => {
    if (!SESSION_ID_PATTERN.test(sessionId) || !Array.isArray(messages)) return [];
    const importable = messages.filter(isImportableLegacyMessage);
    return importable.length > 0 ? [[sessionId, importable] as const] : [];
  });
  if (sessions.length === 0) {
    archiveLegacySessionMessagesJson();
    return;
  }

  const now = Date.now();
  const findSession = db.prepare("SELECT session_id FROM session_message_sessions WHERE session_id = ?");
  const insertSession = db.prepare(
    "INSERT OR IGNORE INTO session_message_sessions (session_id, updated_at) VALUES (?, ?)",
  );
  const insertRow = db.prepare(`
    INSERT INTO session_message_rows (session_id, message_id, sequence, payload, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, message_id) DO UPDATE SET
      sequence = excluded.sequence,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  try {
    db.exec("BEGIN");
    for (const [sessionId, messages] of sessions) {
      if (findSession.get(sessionId)) continue;
      insertSession.run(sessionId, now);
      messages.forEach((message, sequence) => {
        insertRow.run(sessionId, (message as { id: string }).id, sequence, JSON.stringify(message), now);
      });
    }
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    return;
  }
  archiveLegacySessionMessagesJson();
}

export function closeStoreDatabases(): void {
  const db = sessionMessagesDb;
  sessionMessagesDb = null;
  if (!db) return;
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    // 截断失败无碍：WAL 会在下次打开时重放。
  }
  db.close();
}

/**
 * DELETE 只把页还进 freelist，且 WAL 模式下改动都先落在 -wal 里，主文件不会自己缩小；
 * 所以删完必须 checkpoint。VACUUM 之后还要再 checkpoint 一次：VACUUM 的重写结果先进 WAL，
 * 只 checkpoint 一次的话主文件仍是旧大小（实测 995KB 要第二次 checkpoint 才落到 12KB）。
 * 空间浪费够多时才 VACUUM —— 它会阻塞主进程并需要约两倍临时空间。
 */
function reclaimSessionMessageSpace(db: DatabaseSync): void {
  const checkpoint = () => {
    try {
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch {
      // 有并发读时可能拿不到截断锁，交给下次。
    }
  };
  checkpoint();
  try {
    const pageCount = Number(
      (db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined)?.page_count ?? 0,
    );
    const freePages = Number(
      (db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0,
    );
    if (freePages < VACUUM_MIN_FREE_PAGES || pageCount < VACUUM_MIN_FREE_PAGES) return;
    if (freePages / pageCount < VACUUM_FREE_PAGE_RATIO) return;
    db.exec("VACUUM");
  } catch {
    // 回收失败不影响数据正确性。
    return;
  }
  checkpoint();
}

function parseMessageRows(rows: Array<{ payload?: unknown }>): unknown[] {
  const messages: unknown[] = [];
  for (const row of rows) {
    if (typeof row.payload !== "string") continue;
    try {
      messages.push(JSON.parse(row.payload));
    } catch {
      // Skip damaged individual rows instead of losing the whole session.
    }
  }
  return messages;
}

function loadSessionMessages(sessionId: string): unknown {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const db = getSessionMessagesDb();
  const session = db
    .prepare("SELECT session_id FROM session_message_sessions WHERE session_id = ?")
    .get(normalizedSessionId) as { session_id?: unknown } | undefined;
  if (!session) return null;
  const rows = db
    .prepare("SELECT payload FROM session_message_rows WHERE session_id = ? ORDER BY sequence ASC")
    .all(normalizedSessionId) as Array<{ payload?: unknown }>;
  return parseMessageRows(rows);
}

/**
 * 侧栏只需要首条用户消息来显示会话预览，不应因此把每个会话的完整历史
 * 读进渲染进程。每个会话最多检查前 32 条 payload，且所有会话一次查询。
 */
function loadSessionMessageSummaries(sessionIds: string[]): Record<string, unknown> {
  const normalizedSessionIds = [...new Set((sessionIds || []).map(normalizeSessionId))];
  if (normalizedSessionIds.length === 0) return {};
  const db = getSessionMessagesDb();
  const placeholders = normalizedSessionIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT session_id, payload
    FROM (
      SELECT session_id, payload,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY sequence ASC) AS row_number
      FROM session_message_rows
      WHERE session_id IN (${placeholders})
    )
    WHERE row_number <= 32
    ORDER BY session_id, row_number ASC
  `).all(...normalizedSessionIds) as Array<{ session_id?: unknown; payload?: unknown }>;
  const summaries: Record<string, unknown> = {};
  for (const row of rows) {
    if (typeof row.session_id !== "string" || Object.prototype.hasOwnProperty.call(summaries, row.session_id)) continue;
    if (typeof row.payload !== "string") continue;
    try {
      const message = JSON.parse(row.payload);
      if (isRecord(message) && message.role === "user") summaries[row.session_id] = message;
    } catch {
      // Skip one damaged row and continue looking for the first valid user message.
    }
  }
  return summaries;
}

function loadSessionMessagesPage(
  sessionId: string,
  beforeSequence?: number,
  limit = 500,
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const safeLimit = Math.min(2_000, Math.max(1, Math.floor(Number(limit) || 500)));
  const db = getSessionMessagesDb();
  const session = db
    .prepare("SELECT session_id FROM session_message_sessions WHERE session_id = ?")
    .get(normalizedSessionId) as { session_id?: unknown } | undefined;
  if (!session) return { messages: [], hasMore: false, nextBefore: null, firstSequence: 0 };

  const normalizedBefore = typeof beforeSequence === "number" && Number.isSafeInteger(beforeSequence)
    ? beforeSequence
    : null;
  const rows = normalizedBefore === null
    ? db.prepare(`
        SELECT sequence, payload
        FROM session_message_rows
        WHERE session_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      `).all(normalizedSessionId, safeLimit + 1) as Array<{ sequence?: unknown; payload?: unknown }>
    : db.prepare(`
        SELECT sequence, payload
        FROM session_message_rows
        WHERE session_id = ? AND sequence < ?
        ORDER BY sequence DESC
        LIMIT ?
      `).all(normalizedSessionId, normalizedBefore, safeLimit + 1) as Array<{ sequence?: unknown; payload?: unknown }>;

  const hasMore = rows.length > safeLimit;
  const pageRows = rows.slice(0, safeLimit).reverse();
  const messages = parseMessageRows(pageRows);
  const firstSequence = typeof pageRows[0]?.sequence === "number" ? pageRows[0].sequence : 0;
  return {
    messages,
    hasMore,
    nextBefore: hasMore ? firstSequence : null,
    // 渲染进程保存增量时需要知道这一页在完整会话中的绝对起始序号；
    // 否则只加载最近一页后保存会把旧页的顺序重置为从 0 开始。
    firstSequence,
  };
}

type SessionMessageChanges = {
  replace?: boolean;
  upserts?: Array<{ message: unknown; sequence: number }>;
  deletedIds?: string[];
};

function normalizeMessageChanges(value: unknown): Required<SessionMessageChanges> {
  if (!isRecord(value)) throw new Error("Invalid session message changes.");
  const upserts = Array.isArray(value.upserts)
    ? value.upserts.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.message !== "object" || entry.message === null) return [];
        const sequence = Number(entry.sequence);
        const message = entry.message as Record<string, unknown>;
        if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof message.id !== "string" || !message.id) return [];
        return [{ message: entry.message, sequence }];
      })
    : [];
  const deletedIds = Array.isArray(value.deletedIds)
    ? value.deletedIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
  return {
    replace: value.replace === true,
    upserts,
    deletedIds,
  };
}

function saveSessionMessageChanges(sessionId: string, value: unknown): void {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const changes = normalizeMessageChanges(value);
  const db = getSessionMessagesDb();
  const now = Date.now();
  db.exec("BEGIN");
  try {
    if (changes.replace) {
      db.prepare("DELETE FROM session_message_rows WHERE session_id = ?").run(normalizedSessionId);
    }
    db.prepare(`
      INSERT INTO session_message_sessions (session_id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(normalizedSessionId, now);
    const deleteStatement = db.prepare(
      "DELETE FROM session_message_rows WHERE session_id = ? AND message_id = ?",
    );
    for (const messageId of changes.deletedIds) deleteStatement.run(normalizedSessionId, messageId);
    const upsertStatement = db.prepare(`
      INSERT INTO session_message_rows (session_id, message_id, sequence, payload, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, message_id) DO UPDATE SET
        sequence = excluded.sequence,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    for (const { message, sequence } of changes.upserts) {
      const messageId = (message as { id: string }).id;
      upsertStatement.run(normalizedSessionId, messageId, sequence, JSON.stringify(message), now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // replace 会先整段 DELETE 再写回；只有确实删过行才需要回收空间。
  if (changes.replace || changes.deletedIds.length > 0) reclaimSessionMessageSpace(db);
}

function deleteSessionMessageRows(
  removedSessionIds: Set<string>,
  validSessionIds?: Set<string>,
): void {
  const db = getSessionMessagesDb();
  const rows = db.prepare("SELECT session_id FROM session_message_sessions").all() as Array<{ session_id?: unknown }>;
  const ids = rows
    .map((row) => typeof row.session_id === "string" ? row.session_id : "")
    .filter((sessionId) => (
      removedSessionIds.has(sessionId) || !!validSessionIds && !validSessionIds.has(sessionId)
    ));
  if (ids.length === 0) return;
  db.exec("BEGIN");
  try {
    const rowStatement = db.prepare("DELETE FROM session_message_rows WHERE session_id = ?");
    const sessionStatement = db.prepare("DELETE FROM session_message_sessions WHERE session_id = ?");
    for (const sessionId of ids) {
      rowStatement.run(sessionId);
      sessionStatement.run(sessionId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  reclaimSessionMessageSpace(db);
}

async function ensureDataDir() {
  try {
    await mkdir(dataDir, { recursive: true });
  } catch {
    // Already exists
  }
}

async function readStoreFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return JSON.parse(await readFile(`${filePath}.bak`, "utf-8"));
  }
}

async function writeStoreFile(filePath: string, json: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;
  await writeFile(tempPath, json, "utf-8");
  try {
    // 备份用 rename 轮换，而不是每次都把旧文件整份 copyFile：会话库大时
    // 每次保存要多写一整份副本。rename 只改目录项，且同目录内是原子的。
    // 两次 rename 之间若进程退出，主文件虽缺失，但 .bak 是完整的上一版，
    // readStoreFile 会回退读它（见上）。
    try {
      await rm(backupPath, { force: true });
      await rename(filePath, backupPath);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function pruneRecord(
  value: unknown,
  removedSessionIds: Set<string>,
  validSessionIds?: Set<string>,
) {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([sessionId]) =>
    !removedSessionIds.has(sessionId) && (!validSessionIds || validSessionIds.has(sessionId))
  ));
}

export function pruneSessionStoreData(key: string, value: unknown, request: SessionDataPurgeRequest): unknown {
  if (!isRecord(value)) return value;
  const removedSessionIds = normalizeIds(request.sessionIds);
  const removedProjectIds = normalizeIds(request.projectIds);
  const validSessionIds = Array.isArray(request.validSessionIds)
    ? normalizeIds(request.validSessionIds)
    : undefined;
  const validProjectIds = Array.isArray(request.validProjectIds)
    ? normalizeIds(request.validProjectIds)
    : undefined;

  if (key === "currentModel") {
    return {
      ...value,
      models: pruneRecord(value.models, removedSessionIds, validSessionIds),
      thinkingLevels: pruneRecord(value.thinkingLevels, removedSessionIds, validSessionIds),
    };
  }
  if (key === "projects" && Array.isArray(value.projects)) {
    const projects = value.projects.flatMap((item): unknown[] => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        removedProjectIds.has(item.id) ||
        (validProjectIds && !validProjectIds.has(item.id))
      ) return [];
      const sessions = Array.isArray(item.sessions)
        ? item.sessions.filter((session) =>
            !isRecord(session) || typeof session.id !== "string" || (
              !removedSessionIds.has(session.id) && (!validSessionIds || validSessionIds.has(session.id))
            )
          )
        : item.sessions;
      return [{ ...item, sessions }];
    });
    return {
      ...value,
      projects,
      activeProjectId: typeof value.activeProjectId === "string" && (
        removedProjectIds.has(value.activeProjectId) || (validProjectIds && !validProjectIds.has(value.activeProjectId))
      )
        ? null
        : value.activeProjectId,
      activeSessionId: typeof value.activeSessionId === "string" && (
        removedSessionIds.has(value.activeSessionId) || (validSessionIds && !validSessionIds.has(value.activeSessionId))
      )
        ? null
        : value.activeSessionId,
    };
  }
  return value;
}

async function replaceStoreCopy(filePath: string, key: string, request: SessionDataPurgeRequest) {
  let current: unknown;
  try {
    current = JSON.parse(await readFile(filePath, "utf-8"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    await rm(filePath, { force: true });
    return;
  }
  const json = JSON.stringify(pruneSessionStoreData(key, current, request), null, 2);
  const tempPath = `${filePath}.purge.tmp`;
  await writeFile(tempPath, json, "utf-8");
  try {
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function purgeSessionStore(request: SessionDataPurgeRequest) {
  const sessionIds = normalizeIds(request.sessionIds);
  const projectIds = normalizeIds(request.projectIds);
  const hasValidSessionIds = Array.isArray(request.validSessionIds);
  const hasValidProjectIds = Array.isArray(request.validProjectIds);
  if (sessionIds.size === 0 && projectIds.size === 0 && !hasValidSessionIds && !hasValidProjectIds) {
    throw new Error("No session data cleanup criteria provided.");
  }
  const normalizedRequest: SessionDataPurgeRequest = {
    sessionIds: [...sessionIds],
    projectIds: [...projectIds],
    ...(hasValidSessionIds ? { validSessionIds: [...normalizeIds(request.validSessionIds)] } : {}),
    ...(hasValidProjectIds ? { validProjectIds: [...normalizeIds(request.validProjectIds)] } : {}),
  };
  await ensureDataDir();
  await Promise.all(["projects", "currentModel"].map((key) =>
    queueStoreWrite(key, async () => {
      const filePath = getStoreFilePath(key);
      await replaceStoreCopy(filePath, key, normalizedRequest);
      await replaceStoreCopy(`${filePath}.bak`, key, normalizedRequest);
    })
  ));
  await queueStoreWrite("sessionMessagesDb", async () => {
    deleteSessionMessageRows(
      sessionIds,
      hasValidSessionIds ? normalizeIds(request.validSessionIds) : undefined,
    );
  });
}

async function queueStoreWrite(key: string, write: () => Promise<void>): Promise<void> {
  const previous = storeWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  storeWriteQueues.set(key, current);
  try {
    await current;
  } finally {
    if (storeWriteQueues.get(key) === current) storeWriteQueues.delete(key);
  }
}

export function registerStoreHandlers() {
  ipcMain.handle("store:loadSessionMessages", (_event, sessionId: string) => {
    try {
      return loadSessionMessages(sessionId);
    } catch {
      return null;
    }
  });

  ipcMain.handle("store:loadSessionMessageSummaries", (_event, sessionIds: string[]) => {
    try {
      return loadSessionMessageSummaries(sessionIds || []);
    } catch {
      return {};
    }
  });

  ipcMain.handle("store:loadSessionMessagesPage", (_event, sessionId: string, beforeSequence?: number, limit?: number) => {
    try {
      return loadSessionMessagesPage(sessionId, beforeSequence, limit);
    } catch {
      return { messages: [], hasMore: false, nextBefore: null, firstSequence: 0 };
    }
  });

  ipcMain.handle("store:saveSessionMessages", (_event, sessionId: string, messages: unknown) => {
    try {
      normalizeSessionId(sessionId);
      return queueStoreWrite("sessionMessagesDb", async () => {
        saveSessionMessageChanges(sessionId, messages);
      }).then(() => ({ success: true })).catch((error: unknown) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    } catch (error: unknown) {
      return Promise.resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  ipcMain.handle("store:load", async (_event, key: string) => {
    try {
      await ensureDataDir();
      const filePath = getStoreFilePath(key);
      return await readStoreFile(filePath);
    } catch {
      return null;
    }
  });

  ipcMain.handle("store:deleteSessionMessages", (_event, sessionIds: string[]) => (
    queueStoreWrite("sessionMessagesDb", async () => {
      deleteSessionMessageRows(new Set((sessionIds || []).map(normalizeSessionId)));
    }).then(() => ({ success: true })).catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  ));

  ipcMain.handle(
    "store:save",
    async (_event, key: string, data: unknown) => {
      try {
        await ensureDataDir();
        const filePath = getStoreFilePath(key);
        // 消息已迁到 SQLite，剩下的都是小配置，统一缩进便于人工排查。
        const json = JSON.stringify(data, null, 2);
        await queueStoreWrite(key, () => writeStoreFile(filePath, json));
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle("store:purgeSessions", async (_event, request: SessionDataPurgeRequest) => {
    try {
      await purgeSessionStore(request || {});
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
