import { ipcMain, type BrowserWindow } from "electron";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { ZodError } from "zod";

import {
  EDITOR_BRIDGE_DEFAULT_PORT,
  EDITOR_BRIDGE_HOST,
  EDITOR_BRIDGE_INSERT_CHANNEL,
  EDITOR_BRIDGE_MAX_BODY_BYTES,
  EDITOR_BRIDGE_PROTOCOL_VERSION,
  EDITOR_BRIDGE_RESULT_CHANNEL,
  EDITOR_BRIDGE_RESULT_TIMEOUT_MS,
  EDITOR_BRIDGE_SEND_PATH,
  EDITOR_BRIDGE_STATUS_PATH,
  EDITOR_BRIDGE_TOKEN_HEADER,
  editorBridgeSendSchema,
  type EditorBridgeDiscovery,
  type EditorBridgeInsertPayload,
  type EditorBridgeInsertResult,
  type EditorBridgeSendRequest,
  type EditorBridgeStatus,
} from "../../shared/editor-bridge-protocol";
import {
  getEditorBridgeDiscoveryPath,
  removeEditorBridgeDiscovery,
  writeEditorBridgeDiscovery,
} from "./discovery";
import { installEditorExtension, listEditorTargets } from "./installers";
import { installZedTasks } from "./zed";

type PendingInsert = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > EDITOR_BRIDGE_MAX_BODY_BYTES) {
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

/**
 * 只服务本机的编辑器客户端。刻意不发任何 CORS 头：浏览器里的网页因此既过不了
 * 预检、也读不到响应，而令牌放在自定义头里，`<form>` 那种简单请求也伪造不了。
 */
export class EditorBridgeServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private token = "";
  private port = 0;
  private runningError: string | undefined;
  private getWindow: () => BrowserWindow | null = () => null;
  private pending = new Map<string, PendingInsert>();

  /** 端口只供测试注入 0（临时端口）；生产一律走默认端口，占用了会自动退让。 */
  constructor(private readonly preferredPort = EDITOR_BRIDGE_DEFAULT_PORT) {}

  async initialize(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
    this.registerIpc();
    await this.start();
  }

  private async start() {
    if (this.httpServer) return;
    this.runningError = undefined;
    this.token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => void this.handleHttp(request, response));
    try {
      this.port = await this.listen(server, this.preferredPort);
      this.httpServer = server;
      const record: EditorBridgeDiscovery = {
        version: EDITOR_BRIDGE_PROTOCOL_VERSION,
        host: EDITOR_BRIDGE_HOST,
        port: this.port,
        token: this.token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      await writeEditorBridgeDiscovery(record);
    } catch (error) {
      this.runningError = errorMessage(error);
      server.close();
    }
  }

  private listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && port !== 0) {
          // 端口被占就退到系统分配的临时端口：客户端一律以发现文件为准。
          resolve(this.listen(server, 0));
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, EDITOR_BRIDGE_HOST);
    });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url || "/", `http://${EDITOR_BRIDGE_HOST}`);
      if (request.method === "GET" && url.pathname === EDITOR_BRIDGE_STATUS_PATH) {
        this.writeJson(response, 200, {
          ok: true,
          app: "hpp",
          protocolVersion: EDITOR_BRIDGE_PROTOCOL_VERSION,
          pid: process.pid,
        });
        return;
      }
      if (request.method !== "POST" || url.pathname !== EDITOR_BRIDGE_SEND_PATH) {
        this.writeJson(response, 404, { ok: false, error: "Not found." });
        return;
      }
      if (!this.authorize(request)) {
        this.writeJson(response, 401, { ok: false, error: "Invalid bridge token." });
        return;
      }
      const payload = editorBridgeSendSchema.parse(await readJsonBody(request));
      await this.dispatchInsert(payload);
      this.writeJson(response, 200, { ok: true, inserted: true });
    } catch (error) {
      if (error instanceof ZodError) {
        this.writeJson(response, 400, { ok: false, error: error.issues[0]?.message || "Invalid request." });
        return;
      }
      this.writeJson(response, 500, { ok: false, error: errorMessage(error) });
    }
  }

  private authorize(request: IncomingMessage) {
    if (!this.token) return false;
    const header = request.headers[EDITOR_BRIDGE_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || token.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
  }

  private dispatchInsert(request: EditorBridgeSendRequest) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) throw new Error("Hpp 主窗口未就绪。");
    if (window.webContents.isLoading()) throw new Error("Hpp 界面还在加载，请稍后重试。");
    if (request.focus) {
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Hpp 界面没有响应插入请求。"));
      }, EDITOR_BRIDGE_RESULT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      const payload: EditorBridgeInsertPayload = { requestId, request };
      window.webContents.send(EDITOR_BRIDGE_INSERT_CHANNEL, payload);
    });
  }

  private writeJson(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }

  getStatus(): EditorBridgeStatus {
    return {
      running: !!this.httpServer,
      host: EDITOR_BRIDGE_HOST,
      port: this.port,
      protocolVersion: EDITOR_BRIDGE_PROTOCOL_VERSION,
      discoveryPath: getEditorBridgeDiscoveryPath(),
      error: this.runningError,
    };
  }

  private registerIpc() {
    ipcMain.handle("editor-bridge:getStatus", () => this.getStatus());
    ipcMain.handle("editor-bridge:listTargets", () => listEditorTargets());
    ipcMain.handle("editor-bridge:installExtension", (_event, targetId: string) => installEditorExtension(targetId));
    ipcMain.handle("editor-bridge:installZed", () => installZedTasks());
    ipcMain.on(EDITOR_BRIDGE_RESULT_CHANNEL, (_event, result: EditorBridgeInsertResult) => {
      const pending = result?.requestId ? this.pending.get(result.requestId) : undefined;
      if (!pending) return;
      this.pending.delete(result.requestId);
      clearTimeout(pending.timer);
      if (result.success) pending.resolve();
      else pending.reject(new Error(result.error || "插入失败。"));
    });
  }

  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Hpp 正在退出。"));
    }
    this.pending.clear();
    await removeEditorBridgeDiscovery().catch(() => undefined);
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const editorBridgeServer = new EditorBridgeServer();