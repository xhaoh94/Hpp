import { SecureStorage, type DataType } from "@aparajita/capacitor-secure-storage";
import { Capacitor } from "@capacitor/core";
import { MAX_REMOTE_SESSION_REFERENCES } from "@shared/remote-protocol";

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
    updatedAt: typeof draft.updatedAt === "number" && Number.isFinite(draft.updatedAt) ? draft.updatedAt : 0,
  };
}

export async function loadSessionDraft(hostId: string, sessionId: string): Promise<MobileSessionDraft | null> {
  if (!hostId || !sessionId) return null;
  return sanitizeSessionDraft(await readValue(sessionDraftKey(hostId, sessionId)));
}

export async function saveSessionDraft(hostId: string, sessionId: string, draft: Pick<MobileSessionDraft, "text" | "referenceSessionIds">) {
  if (!hostId || !sessionId) return;
  const normalized = sanitizeSessionDraft({ ...draft, updatedAt: Date.now() });
  if (!normalized || (!normalized.text && normalized.referenceSessionIds.length === 0)) {
    await removeValue(sessionDraftKey(hostId, sessionId));
    return;
  }
  await writeValue(sessionDraftKey(hostId, sessionId), {
    text: normalized.text,
    referenceSessionIds: normalized.referenceSessionIds,
    updatedAt: normalized.updatedAt,
  });
}

export async function clearSessionDraft(hostId: string, sessionId: string) {
  if (!hostId || !sessionId) return;
  await removeValue(sessionDraftKey(hostId, sessionId));
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
