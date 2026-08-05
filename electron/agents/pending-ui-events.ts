import type { AgentEvent, AgentUIResponse } from "../../src/types/ipc";
import { isAgentEvent } from "../../src/types/ipc";

const DEFAULT_SOURCE_ID = "session";
const IMPLICIT_REQUEST_ID = "implicit";
const MAX_PENDING_REQUESTS_PER_SESSION = 16;
const MAX_PENDING_SESSIONS = 128;

type PendingUIEventRecord = {
  event: AgentEvent;
  requestId: string;
  sourceId: string;
  // Wall-clock time of the last observation. A record that stays untouched for
  // a long time is stale residue from a finished turn: the backend force-
  // closed the request, the renderer switched sessions without answering, or
  // the answer transport failed. Treating it as still-busy forever would make
  // every later send queue indefinitely even though the conversation finished.
  recordedAt: number;
};

export type PendingUIEventSnapshot = {
  revision: number;
  requests: AgentEvent[];
};

const pendingUIEvents = new Map<string, Map<string, PendingUIEventRecord>>();
const pendingUIRevisions = new Map<string, number>();

const getRevision = (sessionId: string) => pendingUIRevisions.get(sessionId) || 0;
const bumpRevision = (sessionId: string) => {
  const revision = getRevision(sessionId) + 1;
  pendingUIRevisions.set(sessionId, revision);
  return revision;
};

const normalizeToken = (value: unknown) => (
  typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : ""
);

const getRequestId = (value: Record<string, unknown>) => {
  for (const candidate of [value.requestId, value.id, value.toolCallId, value.callId, value.itemId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

const isQuestionEvent = (event: AgentEvent) => {
  if (["extension_ui_request", "user_ask_question", "ask_user_question", "ask_user"].includes(event.type)) {
    return true;
  }
  return [event.entryType, event.kind, event.mode, event.toolKind]
    .some((value) => normalizeToken(value) === "question");
};

const isPendingQuestionEvent = (event: AgentEvent) => {
  if (event.isError === true) return false;
  for (const value of [event.state, event.status, event.phase]) {
    const token = normalizeToken(value);
    if (!token) continue;
    if ([
      "completed", "complete", "done", "idle", "success", "succeeded", "skipped",
      "error", "failed", "failure", "interrupted", "cancelled", "canceled", "stopped",
    ].includes(token)) return false;
    if ([
      "running", "active", "in_progress", "inprogress", "pending", "queued", "started",
      "starting", "working",
    ].includes(token)) return true;
  }
  return true;
};

const SESSION_TERMINAL_EVENT_TYPES = new Set([
  "aborted",
  "turn_failed",
  "agent_disconnected",
]);

const isAuthoritativeSessionTerminalEvent = (event: AgentEvent) => (
  SESSION_TERMINAL_EVENT_TYPES.has(event.type)
  // A normal stream_end can precede a host-rendered answer, so it must keep
  // the pending request replayable. `force` is different: renderer lifecycle
  // handling also closes the interaction immediately, and retaining it only
  // in the main-process cache would make the next send look busy and queue.
  || (event.type === "stream_end" && event.force === true)
);

const getRecordKey = (sourceId: string, requestId: string) => `${sourceId}\u0000${requestId}`;

const removeRecord = (sessionId: string, sourceId: string, requestId?: string) => {
  const sessionEvents = pendingUIEvents.get(sessionId);
  if (!sessionEvents) return false;
  let changed = false;
  if (requestId) {
    changed = sessionEvents.delete(getRecordKey(sourceId, requestId));
    if (!changed) {
      const sourceRecords = [...sessionEvents.entries()]
        .filter(([, record]) => record.sourceId === sourceId);
      // Match the renderer's question lifecycle fallback: adapters sometimes
      // change IDs between start and end, and one unresolved request is still
      // unambiguous. Never guess when several requests are pending.
      if (sourceRecords.length === 1) {
        sessionEvents.delete(sourceRecords[0][0]);
        changed = true;
      }
    }
  } else {
    for (const [key, record] of sessionEvents) {
      if (record.sourceId !== sourceId) continue;
      sessionEvents.delete(key);
      changed = true;
    }
  }
  if (sessionEvents.size === 0) pendingUIEvents.delete(sessionId);
  if (changed) bumpRevision(sessionId);
  return changed;
};

/**
 * Observe the raw event at the main-process plugin transport boundary. This
 * boundary covers built-in and third-party plugins even while no renderer is
 * subscribed, so a pending permission/question can be replayed after HMR.
 */
export function observePendingUIEvent(
  sessionId: string,
  value: unknown,
  sourceId = DEFAULT_SOURCE_ID,
) {
  if (!sessionId || !isAgentEvent(value)) return getRevision(sessionId);
  if (isAuthoritativeSessionTerminalEvent(value)) {
    clearPendingUIEvents(sessionId, sourceId);
    return getRevision(sessionId);
  }
  if (!isQuestionEvent(value)) return getRevision(sessionId);

  const requestId = getRequestId(value) || IMPLICIT_REQUEST_ID;
  if (!isPendingQuestionEvent(value)) {
    removeRecord(sessionId, sourceId, requestId);
    return getRevision(sessionId);
  }

  let sessionEvents = pendingUIEvents.get(sessionId);
  if (!sessionEvents) {
    if (pendingUIEvents.size >= MAX_PENDING_SESSIONS) {
      const oldestSessionId = pendingUIEvents.keys().next().value as string | undefined;
      if (oldestSessionId) pendingUIEvents.delete(oldestSessionId);
    }
    sessionEvents = new Map();
    pendingUIEvents.set(sessionId, sessionEvents);
  }
  const key = getRecordKey(sourceId, requestId);
  if (!sessionEvents.has(key) && sessionEvents.size >= MAX_PENDING_REQUESTS_PER_SESSION) {
    const oldestKey = sessionEvents.keys().next().value as string | undefined;
    if (oldestKey) sessionEvents.delete(oldestKey);
  }
  sessionEvents.set(key, {
    event: { ...value, sessionId },
    requestId,
    sourceId,
    recordedAt: Date.now(),
  });
  return bumpRevision(sessionId);
}

/**
 * Number of pending UI requests that have not been observed for at least
 * `maxAgeMs`. Only these can be safely treated as expired: a freshly recorded
 * request still legitimately blocks the session while the user reads and
 * answers it.
 */
export function hasStalePendingUIEvents(sessionId: string, maxAgeMs: number): boolean {
  const sessionEvents = pendingUIEvents.get(sessionId);
  if (!sessionEvents || sessionEvents.size === 0) return false;
  const now = Date.now();
  for (const record of sessionEvents.values()) {
    if (now - record.recordedAt > maxAgeMs) return true;
  }
  return false;
}

/**
 * Drop pending UI requests that have been untouched for at least `maxAgeMs`.
 * Returns the number of removed records so callers can tell whether the
 * session's busy state came from stale residue.
 */
export function pruneStalePendingUIEvents(sessionId: string, maxAgeMs: number): number {
  const sessionEvents = pendingUIEvents.get(sessionId);
  if (!sessionEvents) return 0;
  const now = Date.now();
  let removed = 0;
  for (const [key, record] of sessionEvents) {
    if (now - record.recordedAt <= maxAgeMs) continue;
    sessionEvents.delete(key);
    removed += 1;
  }
  if (removed > 0) {
    if (sessionEvents.size === 0) pendingUIEvents.delete(sessionId);
    bumpRevision(sessionId);
  }
  return removed;
}

export function getPendingUIEvents(sessionId: string): AgentEvent[] {
  return [...(pendingUIEvents.get(sessionId)?.values() || [])]
    .map(({ event }) => ({ ...event }));
}

export function getPendingUIEventSnapshot(sessionId: string): PendingUIEventSnapshot {
  return {
    revision: getRevision(sessionId),
    requests: getPendingUIEvents(sessionId),
  };
}

export function hasPendingUIEvents(sessionId: string): boolean {
  return (pendingUIEvents.get(sessionId)?.size || 0) > 0;
}

export function clearPendingUIEvents(sessionId: string, sourceId?: string) {
  if (!sourceId) {
    if (pendingUIEvents.delete(sessionId)) bumpRevision(sessionId);
    return getRevision(sessionId);
  }
  removeRecord(sessionId, sourceId);
  return getRevision(sessionId);
}

export function clearPendingUIResponse(sessionId: string, response: AgentUIResponse) {
  const sessionEvents = pendingUIEvents.get(sessionId);
  if (!sessionEvents) return getRevision(sessionId);
  const responseId = getRequestId(response);
  if (!responseId) {
    // The renderer currently exposes one interaction per session. A successful
    // unkeyed response is therefore unambiguous only when one request exists.
    if (sessionEvents.size === 1) {
      pendingUIEvents.delete(sessionId);
      bumpRevision(sessionId);
    }
    return getRevision(sessionId);
  }
  let changed = false;
  for (const [key, record] of sessionEvents) {
    if (record.requestId !== responseId) continue;
    sessionEvents.delete(key);
    changed = true;
  }
  if (!changed && sessionEvents.size === 1) {
    sessionEvents.clear();
    changed = true;
  }
  if (sessionEvents.size === 0) pendingUIEvents.delete(sessionId);
  if (changed) bumpRevision(sessionId);
  return getRevision(sessionId);
}

export function clearAllPendingUIEvents() {
  pendingUIEvents.clear();
  pendingUIRevisions.clear();
}
