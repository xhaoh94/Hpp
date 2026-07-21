import { SecureStorage, type DataType } from "@aparajita/capacitor-secure-storage";
import { Capacitor } from "@capacitor/core";
import { MAX_REMOTE_SESSION_REFERENCES } from "@shared/remote-protocol";
import { isAgentActionInvocation, type AgentActionInvocation } from "@shared/agent-actions";

export interface PairedHost {
  id: string;
  hostId: string;
  hostName: string;
  alias?: string;
  note?: string;
  baseUrl: string;
  baseUrls?: string[];
  deviceId: string;
  token: string;
}

export interface MobileSessionDraft {
  text: string;
  referenceSessionIds: string[];
  action?: AgentActionInvocation;
  updatedAt: number;
}

export function withPairedHostMetadata(host: PairedHost, aliasValue: string, noteValue: string): PairedHost {
  const { alias: _alias, note: _note, ...base } = host;
  const alias = aliasValue.trim().slice(0, 80);
  const note = noteValue.trim().slice(0, 200);
  return {
    ...base,
    ...(alias ? { alias } : {}),
    ...(note ? { note } : {}),
  };
}

const HOSTS_KEY = "hpp-mobile-hosts";
const LAST_HOST_KEY = "hpp-mobile-last-host";
const SESSION_DRAFT_KEY_PREFIX = "hpp-mobile-draft-v1";
const SESSION_DRAFT_INDEX_PREFIX = "hpp-mobile-draft-index-v1";
const KEY_PREFIX = "hpp_mobile_";

export function sanitizePairedHosts(value: unknown): PairedHost[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PairedHost[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const host = item as Record<string, unknown>;
    const valid = ["id", "hostId", "hostName", "baseUrl", "deviceId", "token"]
      .every((key) => typeof host[key] === "string" && !!host[key]);
    if (!valid) return [];
    const alias = typeof host.alias === "string" ? host.alias.trim().slice(0, 80) : "";
    const note = typeof host.note === "string" ? host.note.trim().slice(0, 200) : "";
    const baseUrls = Array.isArray(host.baseUrls)
      ? [...new Set(host.baseUrls
        .filter((url): url is string => typeof url === "string" && !!url.trim())
        .map((url) => url.trim())
        .filter((url) => url.length <= 2048))].slice(0, 16)
      : [];
    return [{
      id: host.id as string,
      hostId: host.hostId as string,
      hostName: host.hostName as string,
      ...(alias ? { alias } : {}),
      ...(note ? { note } : {}),
      baseUrl: host.baseUrl as string,
      ...(baseUrls.length > 0 ? { baseUrls } : {}),
      deviceId: host.deviceId as string,
      token: host.token as string,
    }];
  });
}

const webStorageKey = (key: string) => `${KEY_PREFIX}${key}`;

async function readValue(key: string): Promise<unknown> {
  if (!Capacitor.isNativePlatform()) {
    const raw = localStorage.getItem(webStorageKey(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  await SecureStorage.setKeyPrefix(KEY_PREFIX);
  return SecureStorage.get(key);
}

async function writeValue(key: string, value: DataType) {
  if (!Capacitor.isNativePlatform()) {
    localStorage.setItem(webStorageKey(key), JSON.stringify(value));
    return;
  }
  await SecureStorage.setKeyPrefix(KEY_PREFIX);
  await SecureStorage.set(key, value);
}

async function removeValue(key: string) {
  if (!Capacitor.isNativePlatform()) {
    localStorage.removeItem(webStorageKey(key));
    return;
  }
  await SecureStorage.setKeyPrefix(KEY_PREFIX);
  await SecureStorage.remove(key);
}

const sessionDraftKey = (hostId: string, sessionId: string) =>
  `${SESSION_DRAFT_KEY_PREFIX}:${encodeURIComponent(hostId)}:${encodeURIComponent(sessionId)}`;

const sessionDraftIndexKey = (hostId: string) =>
  `${SESSION_DRAFT_INDEX_PREFIX}:${encodeURIComponent(hostId)}`;

const sanitizeDraftIndex = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string" && !!item.trim()))]
  : [];

async function loadDraftIndex(hostId: string) {
  return sanitizeDraftIndex(await readValue(sessionDraftIndexKey(hostId)));
}

async function saveDraftIndex(hostId: string, sessionIds: string[]) {
  const normalized = sanitizeDraftIndex(sessionIds);
  if (normalized.length === 0) {
    await removeValue(sessionDraftIndexKey(hostId));
    return;
  }
  await writeValue(sessionDraftIndexKey(hostId), normalized);
}

async function listStoredDraftSessionIds(hostId: string) {
  const indexed = await loadDraftIndex(hostId);
  const prefix = `${SESSION_DRAFT_KEY_PREFIX}:${encodeURIComponent(hostId)}:`;
  let keys: string[] = [];
  if (Capacitor.isNativePlatform()) {
    await SecureStorage.setKeyPrefix(KEY_PREFIX);
    keys = await SecureStorage.keys();
  } else {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key.slice(KEY_PREFIX.length));
    }
  }
  const discovered = keys.flatMap((key): string[] => {
    if (!key.startsWith(prefix)) return [];
    try {
      return [decodeURIComponent(key.slice(prefix.length))];
    } catch {
      return [];
    }
  });
  return [...new Set([...indexed, ...discovered])];
}

export function sanitizeSessionDraft(value: unknown): MobileSessionDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.text !== "string" || draft.text.length > 200_000) return null;
  const referenceSessionIds = Array.isArray(draft.referenceSessionIds)
    ? [...new Set(draft.referenceSessionIds.filter((id): id is string => typeof id === "string" && !!id.trim()))].slice(0, MAX_REMOTE_SESSION_REFERENCES)
    : [];
  return {
    text: draft.text,
    referenceSessionIds,
    ...(isAgentActionInvocation(draft.action)
      ? { action: { kind: draft.action.kind, name: draft.action.name.trim() } }
      : {}),
    updatedAt: typeof draft.updatedAt === "number" && Number.isFinite(draft.updatedAt) ? draft.updatedAt : 0,
  };
}

export async function loadSessionDraft(hostId: string, sessionId: string): Promise<MobileSessionDraft | null> {
  if (!hostId || !sessionId) return null;
  return sanitizeSessionDraft(await readValue(sessionDraftKey(hostId, sessionId)));
}

export async function saveSessionDraft(hostId: string, sessionId: string, draft: Pick<MobileSessionDraft, "text" | "referenceSessionIds" | "action">) {
  if (!hostId || !sessionId) return;
  const normalized = sanitizeSessionDraft({ ...draft, updatedAt: Date.now() });
  if (!normalized || (!normalized.text && normalized.referenceSessionIds.length === 0 && !normalized.action)) {
    await clearSessionDraft(hostId, sessionId);
    return;
  }
  await writeValue(sessionDraftKey(hostId, sessionId), {
    text: normalized.text,
    referenceSessionIds: normalized.referenceSessionIds,
    action: normalized.action,
    updatedAt: normalized.updatedAt,
  });
  const indexed = await loadDraftIndex(hostId);
  if (!indexed.includes(sessionId)) await saveDraftIndex(hostId, [...indexed, sessionId]);
}

export async function clearSessionDraft(hostId: string, sessionId: string) {
  if (!hostId || !sessionId) return;
  await removeValue(sessionDraftKey(hostId, sessionId));
  const indexed = await loadDraftIndex(hostId);
  if (indexed.includes(sessionId)) await saveDraftIndex(hostId, indexed.filter((id) => id !== sessionId));
}

export async function pruneSessionDrafts(hostId: string, validSessionIds: Iterable<string>) {
  if (!hostId) return;
  const valid = new Set([...validSessionIds].filter(Boolean));
  const stored = await listStoredDraftSessionIds(hostId);
  await Promise.all(stored
    .filter((sessionId) => !valid.has(sessionId))
    .map((sessionId) => removeValue(sessionDraftKey(hostId, sessionId))));
  await saveDraftIndex(hostId, stored.filter((sessionId) => valid.has(sessionId)));
}

export async function clearHostSessionDrafts(hostId: string) {
  await pruneSessionDrafts(hostId, []);
}

export async function loadPairedHosts(): Promise<PairedHost[]> {
  return sanitizePairedHosts(await readValue(HOSTS_KEY));
}

export async function savePairedHosts(hosts: PairedHost[]) {
  await writeValue(HOSTS_KEY, hosts);
}

export async function loadLastPairedHostId(): Promise<string | null> {
  const value = await readValue(LAST_HOST_KEY);
  return typeof value === "string" && value ? value : null;
}

export async function saveLastPairedHostId(hostId: string) {
  await writeValue(LAST_HOST_KEY, hostId);
}
