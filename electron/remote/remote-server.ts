import { app, ipcMain, type BrowserWindow } from "electron";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { networkInterfaces, hostname } from "os";
import { access, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { extname, join, resolve, sep } from "path";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import {
  DEFAULT_REMOTE_PORT,
  MAX_REMOTE_REQUEST_BYTES,
  REMOTE_HISTORY_PAGE_SIZE,
  REMOTE_PROTOCOL_VERSION,
  parseRemoteRequest,
  remoteAuthEnvelopeSchema,
  remotePairRequestSchema,
  type RemoteAccessStatus,
  type RemoteAgent,
  type RemoteCatalogSnapshot,
  type RemoteChatMessage,
  type RemoteDeviceInfo,
  type RemoteEventName,
  type RemoteInteraction,
  type RemotePairingOffer,
  type RemoteProject,
  type RemoteQueuedMessage,
  type RemoteRendererPublish,
  type RemoteServerEnvelope,
  type RemoteSessionConfig,
} from "../../shared/remote-protocol";

type RemoteConfigFile = {
  version: 1;
  hostId: string;
  enabled: boolean;
  bindAddress: string;
  advertiseAddress: string;
  port: number;
  devices: Array<RemoteDeviceInfo & { tokenHash: string }>;
};

type PendingRendererCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AuthenticatedSocket = WebSocket & { deviceId?: string; authenticated?: boolean };

const CONFIG_VERSION = 1 as const;
const AUTH_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 30_000;
const SESSION_CREATE_TIMEOUT_MS = 60_000;
const PAIRING_TTL_MS = 5 * 60_000;
const PAIR_RATE_LIMIT_WINDOW_MS = 60_000;
const PAIR_RATE_LIMIT_MAX = 5;
const IDEMPOTENCY_LIMIT = 500;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const webContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashEquals(expectedHex: string, value: string) {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(sha256(value), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function getNetworkAddresses() {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry.internal && entry.family === "IPv4") addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function normalizePort(value: unknown) {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Port must be between 1024 and 65535.");
  }
  return port;
}

function formatHttpOrigin(address: string, port: number) {
  const normalized = address.trim() || "127.0.0.1";
  if (/^https?:\/\//i.test(normalized)) return normalized.replace(/\/$/, "");
  const host = normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
  return `http://${host}:${port}`;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

class RemoteAccessServer {
  private config: RemoteConfigFile | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private runningError: string | undefined;
  private getWindow: () => BrowserWindow | null = () => null;
  private pairing: { id: string; secretHash: string; expiresAt: number } | null = null;
  private pairAttempts = new Map<string, number[]>();
  private sockets = new Set<AuthenticatedSocket>();
  private catalog: RemoteProject[] = [];
  private agents: RemoteAgent[] = [];
  private messages = new Map<string, RemoteChatMessage[]>();
  private queues = new Map<string, RemoteQueuedMessage[]>();
  private interactions = new Map<string, RemoteInteraction | null>();
  private configs = new Map<string, RemoteSessionConfig>();
  private revisions = new Map<string, number>();
  private hostEpoch = randomUUID();
  private rendererReady = false;
  private pendingRendererCommands = new Map<string, PendingRendererCommand>();
  private commandResults = new Map<string, Map<string, unknown>>();
  private webRoot: string | null = null;

  private get configPath() {
    return join(app.getPath("userData"), "hpp-data", "remote-access.json");
  }

  async initialize(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
    await this.loadConfig();
    if (this.config && !this.config.enabled) {
      this.config.enabled = true;
      await this.saveConfig();
    }
    this.webRoot = await this.findWebRoot();
    this.registerIpc();
    await this.start();
  }

  private async loadConfig() {
    try {
      const raw = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<RemoteConfigFile>;
      this.config = {
        version: CONFIG_VERSION,
        hostId: typeof raw.hostId === "string" && raw.hostId ? raw.hostId : randomUUID(),
        enabled: raw.enabled === true,
        bindAddress: typeof raw.bindAddress === "string" && raw.bindAddress ? raw.bindAddress : "0.0.0.0",
        advertiseAddress: typeof raw.advertiseAddress === "string" ? raw.advertiseAddress : "",
        port: normalizePort(raw.port ?? DEFAULT_REMOTE_PORT),
        devices: Array.isArray(raw.devices)
          ? raw.devices.filter((device): device is RemoteConfigFile["devices"][number] => (
              !!device && typeof device.id === "string" && typeof device.name === "string" &&
              typeof device.tokenHash === "string" && typeof device.createdAt === "string"
            ))
          : [],
      };
    } catch {
      this.config = {
        version: CONFIG_VERSION,
        hostId: randomUUID(),
        enabled: true,
        bindAddress: "0.0.0.0",
        advertiseAddress: "",
        port: DEFAULT_REMOTE_PORT,
        devices: [],
      };
      await this.saveConfig();
    }
  }

  private async saveConfig() {
    if (!this.config) return;
    const directory = join(app.getPath("userData"), "hpp-data");
    const tempPath = `${this.configPath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tempPath, JSON.stringify(this.config, null, 2), "utf8");
    try {
      await rename(tempPath, this.configPath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private async findWebRoot() {
    const candidates = [
      join(__dirname, "../mobile"),
      join(app.getAppPath(), "out", "mobile"),
      join(process.cwd(), "out", "mobile"),
      join(process.cwd(), "mobile", "dist"),
    ];
    for (const candidate of [...new Set(candidates.map((item) => resolve(item)))]) {
      try {
        await access(join(candidate, "index.html"));
        return candidate;
      } catch {
        // Try the next development or packaged output location.
      }
    }
    return null;
  }

  private registerIpc() {
    ipcMain.handle("remote:getStatus", () => this.getStatus());
    ipcMain.handle("remote:configure", async (_event, patch: Partial<Pick<RemoteAccessStatus, "enabled" | "bindAddress" | "advertiseAddress" | "port">>) => {
      if (!this.config) throw new Error("Remote access is not initialized.");
      const previous = { ...this.config };
      this.config.enabled = patch.enabled ?? this.config.enabled;
      this.config.bindAddress = typeof patch.bindAddress === "string" && patch.bindAddress.trim()
        ? patch.bindAddress.trim()
        : this.config.bindAddress;
      this.config.advertiseAddress = typeof patch.advertiseAddress === "string"
        ? patch.advertiseAddress.trim()
        : this.config.advertiseAddress;
      if (patch.port !== undefined) this.config.port = normalizePort(patch.port);
      await this.saveConfig();
      const needsRestart = previous.bindAddress !== this.config.bindAddress || previous.port !== this.config.port;
      if (!this.config.enabled) await this.stop();
      else if (!this.httpServer || needsRestart) {
        await this.stop();
        await this.start();
      }
      return this.getStatus();
    });
    ipcMain.handle("remote:beginPairing", () => this.beginPairing());
    ipcMain.handle("remote:revokeDevice", async (_event, deviceId: string) => this.revokeDevice(deviceId));
    ipcMain.on("remote:publish", (_event, update: RemoteRendererPublish) => this.applyRendererPublish(update));
    ipcMain.on("remote:commandResult", (_event, result: { commandId?: unknown; success?: unknown; payload?: unknown; error?: unknown }) => {
      if (typeof result?.commandId !== "string") return;
      const pending = this.pendingRendererCommands.get(result.commandId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRendererCommands.delete(result.commandId);
      if (result.success === false) pending.reject(new Error(typeof result.error === "string" ? result.error : "Remote command failed."));
      else pending.resolve(result.payload);
    });
  }

  private getStatus(): RemoteAccessStatus {
    const config = this.config!;
    const addresses = getNetworkAddresses();
    return {
      enabled: config.enabled,
      running: !!this.httpServer,
      bindAddress: config.bindAddress,
      port: config.port,
      advertiseAddress: config.advertiseAddress || addresses[0] || "127.0.0.1",
      hostId: config.hostId,
      hostName: hostname(),
      addresses,
      devices: config.devices.map(({ tokenHash: _tokenHash, ...device }) => device),
      error: this.runningError,
    };
  }

  private async start() {
    if (this.httpServer || !this.config?.enabled) return;
    const config = this.config;
    this.runningError = undefined;
    const httpServer = createServer((request, response) => void this.handleHttp(request, response));
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_REMOTE_REQUEST_BYTES });
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname !== "/api/v1/ws") {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (socket) => this.handleSocket(socket as AuthenticatedSocket));

    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, config.bindAddress, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      this.httpServer = httpServer;
      this.webSocketServer = webSocketServer;
    } catch (error) {
      this.runningError = errorMessage(error);
      webSocketServer.close();
      httpServer.close();
    }
  }

  private async stop() {
    for (const socket of this.sockets) socket.close(1001, "Remote access stopped");
    this.sockets.clear();
    this.webSocketServer?.close();
    this.webSocketServer = null;
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private writeJson(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, jsonHeaders);
    response.end(JSON.stringify(body));
  }

  private async serveWebAsset(request: IncomingMessage, response: ServerResponse, pathname: string) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    if (!this.webRoot) this.webRoot = await this.findWebRoot();
    if (!this.webRoot) return false;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const root = resolve(this.webRoot);
    let filePath = resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return false;

    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      if (extname(relativePath)) return false;
      filePath = join(root, "index.html");
      try {
        content = await readFile(filePath);
      } catch {
        return false;
      }
    }

    const extension = extname(filePath).toLowerCase();
    const immutableAsset = relativePath.startsWith("assets/");
    response.writeHead(200, {
      "Content-Type": webContentTypes[extension] || "application/octet-stream",
      "Cache-Control": immutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "Service-Worker-Allowed": "/",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
    return true;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "OPTIONS") {
      response.writeHead(204, jsonHeaders);
      response.end();
      return;
    }
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      this.writeJson(response, 200, {
        ok: true,
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        hostId: this.config?.hostId,
        hostName: hostname(),
        rendererReady: this.rendererReady,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/pair") {
      const ip = request.socket.remoteAddress || "unknown";
      if (!this.allowPairAttempt(ip)) {
        this.writeJson(response, 429, { ok: false, error: "Too many pairing attempts." });
        return;
      }
      try {
        const payload = remotePairRequestSchema.parse(await readJsonBody(request));
        const pairing = this.pairing;
        if (
          !pairing || pairing.expiresAt < Date.now() || pairing.id !== payload.pairingId ||
          !safeHashEquals(pairing.secretHash, payload.secret)
        ) {
          this.writeJson(response, 401, { ok: false, error: "Pairing offer is invalid or expired." });
          return;
        }
        this.pairing = null;
        const token = randomBytes(32).toString("base64url");
        const device: RemoteConfigFile["devices"][number] = {
          id: randomUUID(),
          name: payload.deviceName,
          tokenHash: sha256(token),
          createdAt: new Date().toISOString(),
        };
        this.config!.devices.push(device);
        await this.saveConfig();
        this.writeJson(response, 200, {
          ok: true,
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          hostId: this.config!.hostId,
          hostName: hostname(),
          deviceId: device.id,
          token,
        });
      } catch (error) {
        this.writeJson(response, error instanceof ZodError ? 400 : 500, { ok: false, error: errorMessage(error) });
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      this.writeJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    if (await this.serveWebAsset(request, response, url.pathname)) return;
    this.writeJson(response, 404, { ok: false, error: "Not found." });
  }

  private allowPairAttempt(ip: string) {
    const cutoff = Date.now() - PAIR_RATE_LIMIT_WINDOW_MS;
    const attempts = (this.pairAttempts.get(ip) || []).filter((time) => time >= cutoff);
    if (attempts.length >= PAIR_RATE_LIMIT_MAX) return false;
    attempts.push(Date.now());
    this.pairAttempts.set(ip, attempts);
    return true;
  }

  private handleSocket(socket: AuthenticatedSocket) {
    this.sockets.add(socket);
    const authTimer = setTimeout(() => socket.close(4401, "Authentication timed out"), AUTH_TIMEOUT_MS);
    socket.on("message", async (raw) => {
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const value = JSON.parse(text);
        if (!socket.authenticated) {
          const auth = remoteAuthEnvelopeSchema.parse(value);
          const device = this.config?.devices.find((candidate) => candidate.id === auth.deviceId);
          if (!device || !safeHashEquals(device.tokenHash, auth.token)) {
            socket.close(4401, "Authentication failed");
            return;
          }
          clearTimeout(authTimer);
          socket.authenticated = true;
          socket.deviceId = device.id;
          device.lastConnectedAt = new Date().toISOString();
          void this.saveConfig();
          this.sendResponse(socket, auth.requestId, "auth", {
            hostId: this.config!.hostId,
            hostName: hostname(),
            protocolVersion: REMOTE_PROTOCOL_VERSION,
          });
          return;
        }

        const request = parseRemoteRequest(value);
        const payload = await this.handleRemoteRequest(socket, request.name, request.payload);
        this.sendResponse(socket, request.requestId, request.name, payload);
      } catch (error) {
        const requestId = (() => {
          try {
            const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
            return typeof parsed.requestId === "string" ? parsed.requestId : randomUUID();
          } catch {
            return randomUUID();
          }
        })();
        this.sendError(socket, requestId, "request", error instanceof ZodError ? "INVALID_REQUEST" : "REQUEST_FAILED", errorMessage(error));
      }
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      this.sockets.delete(socket);
    });
    socket.on("error", () => this.sockets.delete(socket));
  }

  private async handleRemoteRequest(socket: AuthenticatedSocket, name: string, payload: Record<string, unknown>) {
    if (!this.rendererReady && name !== "catalog.get") throw new Error("Desktop UI is not ready.");
    if (name === "catalog.get") {
      return { projects: this.catalog, agents: this.agents, hostEpoch: this.hostEpoch } satisfies RemoteCatalogSnapshot;
    }
    if (name === "session.get") {
      const sessionId = String(payload.sessionId);
      const messages = this.messages.get(sessionId) || [];
      const end = typeof payload.before === "number" ? Math.min(payload.before, messages.length) : messages.length;
      const limit = Math.min(Number(payload.limit) || REMOTE_HISTORY_PAGE_SIZE, REMOTE_HISTORY_PAGE_SIZE);
      const start = Math.max(0, end - limit);
      return {
        sessionId,
        messages: messages.slice(start, end),
        nextBefore: start > 0 ? start : null,
        revision: this.revisions.get(sessionId) || 0,
        queue: this.queues.get(sessionId) || [],
        interaction: this.interactions.get(sessionId) || null,
        config: this.configs.get(sessionId) || null,
      };
    }

    if (name === "session.send") {
      const deviceId = socket.deviceId!;
      const clientMessageId = String(payload.clientMessageId);
      const cached = this.commandResults.get(deviceId)?.get(clientMessageId);
      if (cached !== undefined) return cached;
      const result = await this.sendRendererCommand(name, payload);
      this.rememberCommandResult(deviceId, clientMessageId, result);
      return result;
    }

    return this.sendRendererCommand(
      name,
      payload,
      name === "session.create" || name === "session.fork" || name === "session.reload"
        ? SESSION_CREATE_TIMEOUT_MS
        : COMMAND_TIMEOUT_MS,
    );
  }

  private sendRendererCommand(name: string, payload: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return Promise.reject(new Error("Desktop UI is unavailable."));
    const commandId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRendererCommands.delete(commandId);
        reject(new Error("Desktop command timed out."));
      }, timeoutMs);
      this.pendingRendererCommands.set(commandId, { resolve, reject, timer });
      window.webContents.send("remote:command", { commandId, name, payload });
    });
  }

  private rememberCommandResult(deviceId: string, commandId: string, result: unknown) {
    let cache = this.commandResults.get(deviceId);
    if (!cache) {
      cache = new Map();
      this.commandResults.set(deviceId, cache);
    }
    cache.set(commandId, result);
    while (cache.size > IDEMPOTENCY_LIMIT) cache.delete(cache.keys().next().value!);
  }

  private applyRendererPublish(update: RemoteRendererPublish) {
    if (!update || typeof update !== "object" || typeof update.type !== "string") return;
    this.rendererReady = true;
    if (update.type === "snapshot") {
      this.catalog = update.catalog;
      this.agents = update.agents;
      this.messages = new Map(Object.entries(update.messages));
      this.queues = new Map(Object.entries(update.queues));
      this.interactions = new Map(Object.entries(update.interactions));
      this.configs = new Map(Object.entries(update.configs));
      this.broadcast("catalog.updated", { projects: this.catalog, agents: this.agents });
      return;
    }
    if (update.type === "catalog") {
      this.catalog = update.catalog;
      this.agents = update.agents;
      this.broadcast("catalog.updated", { projects: this.catalog, agents: this.agents });
      return;
    }
    const revision = this.nextRevision(update.sessionId);
    if (update.type === "session.message.upsert") {
      const messages = [...(this.messages.get(update.sessionId) || [])];
      const index = messages.findIndex((message) => message.id === update.message.id);
      if (index >= 0) messages[index] = update.message;
      else messages.push(update.message);
      this.messages.set(update.sessionId, messages);
      this.broadcast("session.message.upsert", { sessionId: update.sessionId, message: update.message }, revision);
    } else if (update.type === "session.messages.replace") {
      this.messages.set(update.sessionId, update.messages);
      this.broadcast("session.messages.replace", { sessionId: update.sessionId, messages: update.messages }, revision);
    } else if (update.type === "session.queue") {
      this.queues.set(update.sessionId, update.queue);
      this.broadcast("session.queue.updated", { sessionId: update.sessionId, queue: update.queue }, revision);
    } else if (update.type === "session.interaction") {
      this.interactions.set(update.sessionId, update.interaction);
      this.broadcast("session.interaction.updated", { sessionId: update.sessionId, interaction: update.interaction }, revision);
    } else if (update.type === "session.config") {
      this.configs.set(update.sessionId, update.config);
      this.broadcast("session.config.updated", { sessionId: update.sessionId, config: update.config }, revision);
    }
  }

  private nextRevision(sessionId: string) {
    const revision = (this.revisions.get(sessionId) || 0) + 1;
    this.revisions.set(sessionId, revision);
    return revision;
  }

  private sendResponse(socket: WebSocket, requestId: string, name: string, payload: unknown) {
    const envelope: RemoteServerEnvelope = {
      version: REMOTE_PROTOCOL_VERSION,
      kind: "response",
      requestId,
      name,
      ok: true,
      payload,
      hostEpoch: this.hostEpoch,
    };
    socket.send(JSON.stringify(envelope));
  }

  private sendError(socket: WebSocket, requestId: string, name: string, code: string, message: string) {
    const envelope: RemoteServerEnvelope = {
      version: REMOTE_PROTOCOL_VERSION,
      kind: "response",
      requestId,
      name,
      ok: false,
      error: { code, message },
      hostEpoch: this.hostEpoch,
    };
    socket.send(JSON.stringify(envelope));
  }

  private broadcast(name: RemoteEventName, payload: unknown, revision?: number) {
    const envelope: RemoteServerEnvelope = {
      version: REMOTE_PROTOCOL_VERSION,
      kind: "event",
      name,
      payload,
      revision,
      hostEpoch: this.hostEpoch,
    };
    const serialized = JSON.stringify(envelope);
    for (const socket of this.sockets) {
      if (socket.authenticated && socket.readyState === WebSocket.OPEN) socket.send(serialized);
    }
  }

  private async beginPairing(): Promise<RemotePairingOffer> {
    if (!this.httpServer || !this.config?.enabled) throw new Error("Enable remote access before pairing a device.");
    const secret = randomBytes(32).toString("base64url");
    const pairingId = randomUUID();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairing = { id: pairingId, secretHash: sha256(secret), expiresAt };
    const status = this.getStatus();
    const origin = formatHttpOrigin(status.advertiseAddress, status.port);
    const pairingUri = `hpp://pair?v=${REMOTE_PROTOCOL_VERSION}&url=${encodeURIComponent(origin)}&pairingId=${encodeURIComponent(pairingId)}&secret=${encodeURIComponent(secret)}`;
    const webPairingUrl = `${origin}/?pair=${encodeURIComponent(pairingUri)}`;
    return {
      pairingUri,
      webPairingUrl,
      qrDataUrl: await QRCode.toDataURL(webPairingUrl, { width: 280, margin: 1, errorCorrectionLevel: "M" }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private async revokeDevice(deviceId: string) {
    if (!this.config) throw new Error("Remote access is not initialized.");
    this.config.devices = this.config.devices.filter((device) => device.id !== deviceId);
    this.commandResults.delete(deviceId);
    for (const socket of this.sockets) {
      if (socket.deviceId === deviceId) socket.close(4403, "Device revoked");
    }
    await this.saveConfig();
    return this.getStatus();
  }

  async shutdown() {
    for (const pending of this.pendingRendererCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Remote access stopped."));
    }
    this.pendingRendererCommands.clear();
    await this.stop();
  }
}

export const remoteAccessServer = new RemoteAccessServer();
