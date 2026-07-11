import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { app } from "electron";
import { getBundledWorkerPath, getWorkerInvocation } from "../utils/worker-process";

interface RpcRequest {
  kind: "request";
  id: string;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  kind: "response";
  id: string;
  result?: unknown;
  error?: string;
}

interface RpcEvent {
  kind: "event";
  backendId: string;
  event: unknown;
}

type HostMethods = Record<string, (...args: unknown[]) => unknown>;

export interface PluginHostCapabilities {
  getStatus: boolean;
  update: boolean;
  getDefaultThinkingLevel: boolean;
  activateProvider: boolean;
}

export class AgentPluginProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private eventHandlers = new Map<string, (event: unknown) => void>();
  private configHandlers = new Map<string, () => Promise<unknown>>();
  private nextId = 0;
  private nextBackendId = 0;
  private loadPromise: Promise<PluginHostCapabilities> | null = null;

  constructor(
    private readonly entryPath: string,
    private readonly meta: Record<string, unknown>,
    private hostMethods: HostMethods,
  ) {}

  updateHostMethods(hostMethods: HostMethods): void {
    this.hostMethods = hostMethods;
  }

  async ensureLoaded(): Promise<PluginHostCapabilities> {
    if (!this.loadPromise) this.loadPromise = this.start();
    return this.loadPromise;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    await this.ensureLoaded();
    return this.request(method, params);
  }

  async createBackend(
    sessionId: string,
    onEvent: (event: unknown) => void,
    getConfigState?: () => Promise<unknown>,
  ): Promise<{ backendId: string; capabilities: { sendGuidance: boolean; forkSession: boolean } }> {
    await this.ensureLoaded();
    const backendId = `plugin-backend-${++this.nextBackendId}`;
    this.eventHandlers.set(backendId, onEvent);
    if (getConfigState) this.configHandlers.set(backendId, getConfigState);
    try {
      const capabilities = await this.request("createBackend", { backendId, sessionId }) as {
        sendGuidance: boolean;
        forkSession: boolean;
      };
      return { backendId, capabilities };
    } catch (error) {
      this.eventHandlers.delete(backendId);
      this.configHandlers.delete(backendId);
      throw error;
    }
  }

  backendCall(backendId: string, method: string, args: unknown[] = []): Promise<unknown> {
    return this.call("backendCall", { backendId, method, args });
  }

  async disposeBackend(backendId: string): Promise<void> {
    this.eventHandlers.delete(backendId);
    this.configHandlers.delete(backendId);
    await this.call("disposeBackend", { backendId }).catch(() => undefined);
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.loadPromise = null;
    for (const callback of this.pending.values()) callback.reject(new Error("Plugin host stopped."));
    this.pending.clear();
    this.eventHandlers.clear();
    this.configHandlers.clear();
    child?.kill();
  }

  private async start(): Promise<PluginHostCapabilities> {
    const workerPath = getBundledWorkerPath("agent-plugin-host.mjs", dirname(this.entryPath));
    const backendDir = [
      dirname(workerPath),
      join(app.getAppPath(), "out", "main"),
      join(process.cwd(), "out", "main"),
    ].find((candidate) => existsSync(join(candidate, "plugin-backend-codex.mjs")));
    const invocation = getWorkerInvocation(workerPath);
    const child = spawn(invocation.command, invocation.args, {
      env: {
        ...invocation.env,
        HPP_AGENT_BACKEND_DIR: backendDir || "",
        HPP_AGENT_WORKER_DIR: dirname(workerPath),
        HPP_DATA_DIR: String(this.meta.dataDir || ""),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      console.error(`[agent-plugin-host:${String(this.meta.agentId)}]`, line);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.loadPromise = null;
      const error = new Error(`Plugin host exited (${code ?? signal ?? "unknown"}).`);
      for (const callback of this.pending.values()) callback.reject(error);
      this.pending.clear();
    });
    child.on("error", (error) => {
      for (const callback of this.pending.values()) callback.reject(error);
      this.pending.clear();
    });
    return this.request("load", { entryPath: this.entryPath, meta: this.meta }) as Promise<PluginHostCapabilities>;
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Plugin host is not running."));
    const id = `main-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ kind: "request", id, method, params })}\n`);
    });
  }

  private handleLine(line: string): void {
    let message: RpcRequest | RpcResponse | RpcEvent;
    try { message = JSON.parse(line) as RpcRequest | RpcResponse | RpcEvent; } catch { return; }
    if (message.kind === "response") {
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error));
      else callback.resolve(message.result);
      return;
    }
    if (message.kind === "event") {
      this.eventHandlers.get(message.backendId)?.(message.event);
      return;
    }
    void this.handleHostRequest(message);
  }

  private async handleHostRequest(message: RpcRequest): Promise<void> {
    try {
      const params = message.params as { method?: string; args?: unknown[] } | undefined;
      if (message.method !== "hostCall" || !params?.method) throw new Error("Invalid host request.");
      const result = await this.invokeHost(params.method, params.args || []);
      this.sendResponse(message.id, result);
    } catch (error) {
      this.sendResponse(message.id, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private async invokeHost(method: string, args: unknown[]): Promise<unknown> {
    if (method === "getConfigState") {
      return this.configHandlers.get(String(args[0]))?.();
    }
    const hostMethod = this.hostMethods[method];
    if (typeof hostMethod !== "function") throw new Error(`Host method is not allowed: ${method}`);
    return hostMethod(...args);
  }

  private sendResponse(id: string, result?: unknown, error?: string): void {
    this.child?.stdin.write(`${JSON.stringify({ kind: "response", id, result, error })}\n`);
  }
}
