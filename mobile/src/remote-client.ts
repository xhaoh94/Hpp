import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteEventName,
  type RemoteRequestName,
  type RemoteServerEnvelope,
} from "@shared/remote-protocol";
import {
  isLikelyLanRemoteUrl,
  normalizeRemoteBaseUrl,
  uniqueRemoteBaseUrls,
} from "@shared/remote-addresses";
import type { PairedHost } from "./storage";
import { createClientId } from "./web-platform";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "unauthorized";
export type HostAvailability = "checking" | "online" | "offline";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RemoteEventListener = (name: RemoteEventName, payload: unknown, revision?: number, hostEpoch?: string) => void;

export { normalizeRemoteBaseUrl } from "@shared/remote-addresses";

export function getHostBaseUrls(host: Pick<PairedHost, "baseUrl" | "baseUrls">) {
  return uniqueRemoteBaseUrls([host.baseUrl, ...(host.baseUrls || [])]);
}

export function withPreferredHostBaseUrl(host: PairedHost, baseUrl: string, discoveredUrls: string[] = []) {
  const normalized = normalizeRemoteBaseUrl(baseUrl);
  return {
    ...host,
    baseUrl: normalized,
    baseUrls: uniqueRemoteBaseUrls([normalized, ...discoveredUrls, ...(host.baseUrls || []), host.baseUrl]),
  };
}

function toWebSocketUrl(baseUrl: string) {
  const normalizedBaseUrl = normalizeRemoteBaseUrl(baseUrl);
  const url = new URL(normalizedBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function probeRemoteBaseUrl(baseUrl: string, expectedHostId: string | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeRemoteBaseUrl(baseUrl)}/api/v1/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = await response.json() as Record<string, unknown>;
    return result.ok === true &&
      result.protocolVersion === REMOTE_PROTOCOL_VERSION &&
      (!expectedHostId || result.hostId === expectedHostId);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCandidateGroup(baseUrls: string[], expectedHostId: string | undefined, timeoutMs: number) {
  if (baseUrls.length === 0) return null;
  return new Promise<string | null>((resolve) => {
    let remaining = baseUrls.length;
    let settled = false;
    for (const baseUrl of baseUrls) {
      void probeRemoteBaseUrl(baseUrl, expectedHostId, timeoutMs).then((available) => {
        if (settled) return;
        if (available) {
          settled = true;
          resolve(baseUrl);
          return;
        }
        remaining -= 1;
        if (remaining === 0) resolve(null);
      });
    }
  });
}

export async function resolveHostBaseUrl(host: Pick<PairedHost, "baseUrl" | "baseUrls" | "hostId">, timeoutMs = 2500) {
  const candidates = getHostBaseUrls(host);
  const lanCandidates = candidates.filter(isLikelyLanRemoteUrl);
  const fallbackCandidates = candidates.filter((url) => !isLikelyLanRemoteUrl(url));
  const lanResult = await probeCandidateGroup(lanCandidates, host.hostId || undefined, Math.min(timeoutMs, 1000));
  if (lanResult) return lanResult;
  return probeCandidateGroup(fallbackCandidates, host.hostId || undefined, timeoutMs);
}

export async function probeHostAvailability(host: PairedHost, timeoutMs = 2500): Promise<Exclude<HostAvailability, "checking">> {
  return await resolveHostBaseUrl(host, timeoutMs) ? "online" : "offline";
}

export class RemoteClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<RemoteEventListener>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private hostListeners = new Set<(host: PairedHost) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private state: ConnectionState = "disconnected";

  constructor(public host: PairedHost) {}

  onEvent(listener: RemoteEventListener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onState(listener: (state: ConnectionState) => void) {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onHostUpdated(listener: (host: PairedHost) => void) {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  }

  updateHost(host: PairedHost) {
    this.host = host;
  }

  async connect() {
    this.shouldReconnect = true;
    if (this.state === "connecting" || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.setState("connecting");
    const baseUrl = await resolveHostBaseUrl(this.host);
    if (!this.shouldReconnect) return;
    if (!baseUrl) {
      this.setState("disconnected");
      this.scheduleReconnect();
      return;
    }
    const socket = new WebSocket(toWebSocketUrl(baseUrl));
    this.socket = socket;
    socket.onopen = () => {
      const requestId = createClientId();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        socket.close();
      }, 5000);
      this.pending.set(requestId, {
        resolve: (value) => {
          const auth = value && typeof value === "object" ? value as Record<string, unknown> : {};
          if (auth.hostId !== this.host.hostId) {
            this.setState("unauthorized");
            this.shouldReconnect = false;
            socket.close(4401, "Desktop identity changed");
            return;
          }
          const discoveredUrls = Array.isArray(auth.connectionUrls)
            ? auth.connectionUrls.filter((url): url is string => typeof url === "string")
            : [];
          this.host = withPreferredHostBaseUrl(this.host, baseUrl, discoveredUrls);
          for (const listener of this.hostListeners) listener(this.host);
          this.reconnectDelay = 1000;
          this.setState("connected");
        },
        reject: () => undefined,
        timer,
      });
      socket.send(JSON.stringify({
        version: REMOTE_PROTOCOL_VERSION,
        kind: "auth",
        requestId,
        deviceId: this.host.deviceId,
        token: this.host.token,
      }));
    };
    socket.onmessage = (event) => this.handleMessage(String(event.data));
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.rejectPending(new Error("Connection closed."));
      if (event.code === 4401 || event.code === 4403) {
        this.shouldReconnect = false;
        this.setState("unauthorized");
        return;
      }
      this.setState("disconnected");
      this.scheduleReconnect();
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "Client disconnected");
    this.socket = null;
    this.rejectPending(new Error("Disconnected."));
    this.setState("disconnected");
  }

  async request<T = unknown>(name: RemoteRequestName, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state !== "connected") {
      throw new Error("Desktop is not connected.");
    }
    const requestId = createClientId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Request timed out."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({
        version: REMOTE_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        name,
        payload,
      }));
    });
  }

  private handleMessage(raw: string) {
    let envelope: RemoteServerEnvelope;
    try {
      envelope = JSON.parse(raw) as RemoteServerEnvelope;
    } catch {
      return;
    }
    if (envelope.version !== REMOTE_PROTOCOL_VERSION) return;
    if (envelope.kind === "response") {
      const pending = this.pending.get(envelope.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(envelope.requestId);
      if (envelope.ok) pending.resolve(envelope.payload);
      else pending.reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
      return;
    }
    if (envelope.kind === "event") {
      for (const listener of this.eventListeners) {
        listener(envelope.name, envelope.payload, envelope.revision, envelope.hostEpoch);
      }
    }
  }

  private setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(15_000, Math.round(this.reconnectDelay * 1.8));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function extractPairingUrl(input: string) {
  let value = input
    .trim()
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/&amp;/gi, "&");

  for (let attempt = 0; attempt < 2 && /^(?:https?|hpp)%3a%2f%2f/i.test(value); attempt += 1) {
    try {
      value = decodeURIComponent(value);
    } catch {
      break;
    }
  }

  const match = value.match(/(?:https?:\/\/|hpp:\/\/pair)[^\s<>"']+/i);
  return (match?.[0] || value).replace(/[),.;，。]+$/, "");
}

export function parsePairingUri(value: string) {
  let url: URL;
  try {
    url = new URL(extractPairingUrl(value));
  } catch {
    throw new Error("配对链接格式无效，请从桌面 Hpp 重新复制完整配对链接。");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    let nested = url.searchParams.get("pair");
    if (!nested) throw new Error("当前内容只是连接地址，不是配对链接。请在桌面 Hpp 点击“配对”后重新复制。");
    if (/^hpp%3a/i.test(nested)) {
      try {
        nested = decodeURIComponent(nested);
      } catch {
        throw new Error("配对链接已被截断，请从桌面 Hpp 重新复制。");
      }
    }
    return parsePairingUri(nested);
  }
  if (url.protocol !== "hpp:" || url.hostname.toLowerCase() !== "pair") {
    throw new Error("配对链接格式无效，请从桌面 Hpp 重新复制完整配对链接。");
  }
  const baseUrl = url.searchParams.get("url");
  const pairingId = url.searchParams.get("pairingId");
  const secret = url.searchParams.get("secret");
  if (!baseUrl || !pairingId || !secret) throw new Error("配对链接不完整或已被截断，请重新生成。");
  const normalizedBaseUrl = normalizeRemoteBaseUrl(baseUrl);
  const baseUrls = uniqueRemoteBaseUrls([
    ...url.searchParams.getAll("candidate"),
    normalizedBaseUrl,
  ]);
  return { baseUrl: normalizedBaseUrl, baseUrls, pairingId, secret };
}

export async function pairHost(pairingUri: string, deviceName: string): Promise<PairedHost> {
  const offer = parsePairingUri(pairingUri);
  const pairingBaseUrl = await resolveHostBaseUrl({
    baseUrl: offer.baseUrl,
    baseUrls: offer.baseUrls,
    hostId: "",
  });
  if (!pairingBaseUrl) throw new Error("无法连接桌面，请确认手机与桌面位于同一局域网或已加入组网。");
  const response = await fetch(`${pairingBaseUrl}/api/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingId: offer.pairingId, secret: offer.secret, deviceName }),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || result.ok !== true) throw new Error(String(result.error || "Pairing failed."));
  const discoveredUrls = Array.isArray(result.connectionUrls)
    ? result.connectionUrls.filter((url): url is string => typeof url === "string")
    : [];
  return {
    id: createClientId(),
    hostId: String(result.hostId),
    hostName: String(result.hostName || "Hpp Desktop"),
    baseUrl: pairingBaseUrl,
    baseUrls: uniqueRemoteBaseUrls([pairingBaseUrl, ...offer.baseUrls, ...discoveredUrls]),
    deviceId: String(result.deviceId),
    token: String(result.token),
  };
}
