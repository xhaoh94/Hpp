import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteEventName,
  type RemoteRequestName,
  type RemoteServerEnvelope,
} from "@shared/remote-protocol";
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

function isPrivateHttpHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254);
}

export function normalizeRemoteBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http:// or https:// desktop addresses are supported.");
  if (url.protocol === "http:" && !isPrivateHttpHost(url.hostname)) {
    throw new Error("Unencrypted connections are limited to LAN, localhost, and private VPN addresses.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
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

export async function probeHostAvailability(host: PairedHost, timeoutMs = 2500): Promise<Exclude<HostAvailability, "checking">> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeRemoteBaseUrl(host.baseUrl)}/api/v1/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return "offline";
    const result = await response.json() as Record<string, unknown>;
    return result.ok === true && result.hostId === host.hostId ? "online" : "offline";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timeout);
  }
}

export class RemoteClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<RemoteEventListener>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
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

  updateHost(host: PairedHost) {
    this.host = host;
  }

  async connect() {
    this.shouldReconnect = true;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.setState("connecting");
    const socket = new WebSocket(toWebSocketUrl(this.host.baseUrl));
    this.socket = socket;
    socket.onopen = () => {
      const requestId = createClientId();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        socket.close();
      }, 5000);
      this.pending.set(requestId, {
        resolve: () => {
          this.reconnectDelay = 1000;
          this.setState("connected");
        },
        reject: () => {
          this.setState("unauthorized");
          this.shouldReconnect = false;
          socket.close();
        },
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
  return { baseUrl: normalizeRemoteBaseUrl(baseUrl), pairingId, secret };
}

export async function pairHost(pairingUri: string, deviceName: string): Promise<PairedHost> {
  const offer = parsePairingUri(pairingUri);
  const response = await fetch(`${offer.baseUrl}/api/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingId: offer.pairingId, secret: offer.secret, deviceName }),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || result.ok !== true) throw new Error(String(result.error || "Pairing failed."));
  return {
    id: createClientId(),
    hostId: String(result.hostId),
    hostName: String(result.hostName || "Hpp Desktop"),
    baseUrl: offer.baseUrl,
    deviceId: String(result.deviceId),
    token: String(result.token),
  };
}
