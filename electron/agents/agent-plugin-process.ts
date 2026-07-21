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
  uninstall: boolean;
  getDefaultThinkingLevel: boolean;
  readProviderConfig: boolean;
  writeProviderConfig: boolean;
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
  private shutdownPromise: Promise<void> | null = null;
  private stopping = false;
  private terminalError: Error | null = null;

  constructor(
    private readonly entryPath: string,
    private readonly meta: Record<string, unknown>,
    private hostMethods: HostMethods,
  ) {}

  async ensureLoaded(): Promise<PluginHostCapabilities> {
    if (this.stopping || this.shutdownPromise) throw new Error("Plugin host stopped.");
    if (this.terminalError) throw this.terminalError;
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
  ): Promise<{ backendId: string; capabilities: { sendGuidance: boolean; forkSession: boolean; listActions: boolean } }> {
    await this.ensureLoaded();
    const backendId = `plugin-backend-${++this.nextBackendId}`;
    this.eventHandlers.set(backendId, onEvent);
    if (getConfigState) this.configHandlers.set(backendId, getConfigState);
    try {
      const capabilities = await this.request("createBackend", { backendId, sessionId }) as {
        sendGuidance: boolean;
        forkSession: boolean;
        listActions: boolean;
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
    if (!this.child?.stdin.writable) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.request("disposeBackend", { backendId }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Plugin backend dispose timed out.")), 5000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  dispose(): void {
    void this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const child = this.child;
    this.loadPromise = null;
    this.eventHandlers.clear();
    this.configHandlers.clear();
    if (!child) {
      this.rejectPending(new Error("Plugin host stopped."));
      return;
    }

    this.stopping = true;
    this.shutdownPromise = (async () => {
      await Promise.race([
        this.request("shutdown").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (!(await this.waitForExit(child, 1000))) {
        await this.killProcessTree(child);
        await this.waitForExit(child, 500);
      }
      if (this.child === child) this.child = null;
      this.rejectPending(new Error("Plugin host stopped."));
    })().finally(() => {
      this.stopping = false;
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  private async start(): Promise<PluginHostCapabilities> {
    const workerPath = getBundledWorkerPath("agent-plugin-host.mjs", dirname(this.entryPath));
    const agentId = String(this.meta.agentId || "");
    const backendDir = [
      dirname(workerPath),
      join(app.getAppPath(), "out", "main"),
      join(process.cwd(), "out", "main"),
    ].find((candidate) => existsSync(join(candidate, `plugin-backend-${agentId}.mjs`)));
    const invocation = getWorkerInvocation(workerPath);
    const dataDir = String(this.meta.dataDir || "");
    const child = spawn(invocation.command, invocation.args, {
      env: {
        ...invocation.env,
        HPP_AGENT_BACKEND_DIR: backendDir || "",
        HPP_AGENT_WORKER_DIR: backendDir || dirname(workerPath),
        HPP_DATA_DIR: dataDir,
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
      const error = this.stopping
        ? new Error("Plugin host stopped.")
        : new Error(`Plugin host exited (${code ?? signal ?? "unknown"}).`);
      if (!this.stopping) this.terminalError = error;
      this.rejectPending(error);
      if (!this.stopping) {
        for (const handler of this.eventHandlers.values()) {
          handler({ type: "agent_disconnected", reason: "plugin-host-exited" });
        }
      }
      this.eventHandlers.clear();
      this.configHandlers.clear();
    });
    child.on("error", (error) => {
      if (!this.stopping) this.terminalError = error;
      this.rejectPending(error);
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

  private rejectPending(error: Error): void {
    for (const callback of this.pending.values()) callback.reject(error);
    this.pending.clear();
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
    if (child.signalCode !== null && child.signalCode !== undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
    });
  }

  private killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (process.platform === "win32" && child.pid) {
      return new Promise((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          child.kill();
          resolve();
        });
        killer.on("exit", () => resolve());
      });
    }
    child.kill("SIGKILL");
    return Promise.resolve();
  }
}
