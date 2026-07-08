import { BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { AgentEventBuffer } from "./agent-event-buffer";
import { getBundledWorkerPath, getWorkerInvocation } from "../utils/worker-process";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
  clientMessageId?: string;
}

interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  sourceMessageContent?: string;
  throughMessageId?: string;
}

interface AgentForkResult {
  supported: boolean;
  success: boolean;
  sessionFilePath?: string;
  nativeEntryId?: string;
  error?: string;
  reason?: string;
}

const getWorkerPath = () => {
  return getBundledWorkerPath("codex-worker.mjs", __dirname);
};

const CODEX_WORKER_INIT_TIMEOUT_MS = 120_000;

export class CodexAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventBuffer: AgentEventBuffer;
  private pendingResponses = new Map<string, (data: any) => void>();
  private requestId = 0;
  private models: AgentModel[] = [];
  private isAborting = false;
  private activePromptIds = new Set<string>();
  private initPromise: Promise<void> | null = null;
  private initKey: string | null = null;

  constructor(private readonly hppSessionId = "default") {
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }

  get sessionFilePath(): string | null {
    return this._sessionFilePath;
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
    this.eventBuffer.setWindow(win);
  }

  async init(projectPath: string, existingSessionFilePath?: string): Promise<void> {
    const requestedSessionFilePath = existingSessionFilePath || null;
    const nextInitKey = `${projectPath}\n${requestedSessionFilePath || ""}`;
    if (this.initPromise && this.initKey === nextInitKey) {
      return this.initPromise;
    }

    if (this.process && this.projectPath === projectPath && this._sessionFilePath === (existingSessionFilePath || this._sessionFilePath)) {
      return;
    }

    this.initKey = nextInitKey;
    this.dispose();
    this.initKey = nextInitKey;
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.emitEvent({ type: "agent_init", agentId: "codex" });

    const worker = getWorkerInvocation(getWorkerPath(), ["CODEX_NODE_PATH", "PI_NODE_PATH"]);
    const child = spawn(worker.command, worker.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: worker.env,
    });
    this.process = child;

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let stderrText = "";
    const getWorkerErrorDetail = () => stderrText.trim().slice(-2000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          this.handleWorkerMessage(JSON.parse(line));
        } catch {
          // Ignore non-protocol output from dependencies.
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText = `${stderrText}${text}`.slice(-4000);
      console.log("[codex-worker]", text.trim());
    });

    child.on("error", (error) => {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Codex 启动失败",
        detail: `${error.message}\n请确认系统 PATH 中的 node 版本 >= 18，或设置 CODEX_NODE_PATH 指向 Node 18+。`,
        state: "error",
      });
      for (const handler of this.pendingResponses.values()) handler({ type: "error", error: error.message });
      this.pendingResponses.clear();
      this.activePromptIds.clear();
    });

    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      this.activePromptIds.clear();
      const exitReason = signal || (code ?? "unknown");
      const detail = getWorkerErrorDetail();
      const error = [
        `Codex worker exited before completing the request (${exitReason})`,
        detail,
      ].filter(Boolean).join("\n");
      for (const handler of this.pendingResponses.values()) handler({ type: "error", error });
      this.pendingResponses.clear();
      if (!this.isAborting) {
        this.emitEvent({ type: "agent_disconnected" });
      }
    });

    const initPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(initId);
        try {
          child.kill();
        } catch {}
        reject(new Error("Codex worker init timed out"));
      }, CODEX_WORKER_INIT_TIMEOUT_MS);
      const initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: existingSessionFilePath,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "ready") {
          this._sessionFilePath = data.sessionFilePath || existingSessionFilePath || null;
          this.emitEvent({ type: "agent_ready", agentId: "codex", mock: false });
          resolve();
        } else {
          reject(new Error(data.error || "Codex worker init failed"));
        }
      });
    });
    this.initPromise = initPromise;
    try {
      await initPromise;
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
        this.initKey = null;
      }
    }
  }

  async sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Codex worker is not running");
    this.isAborting = false;
    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.sendWorkerCommand({
      id: promptId,
      type: "prompt",
      message,
      images,
      planModeEnabled: !!options?.planModeEnabled,
      permissionMode: options?.permissionMode || (options?.planModeEnabled ? "plan" : "full-access"),
    });
  }

  isIdle(): boolean {
    return !this.isAborting && this.activePromptIds.size === 0 && this.pendingResponses.size === 0;
  }

  async sendGuidance(message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Codex worker is not running");
    const guidanceId = this.createCommandId();
    const displayMessage = options?.displayMessage || message;
    const messagePreview = displayMessage.length > 50 ? `${displayMessage.slice(0, 50)}...` : displayMessage;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(guidanceId);
        reject(new Error("Codex guidance timed out"));
      }, 30000);
      this.sendWorkerCommand({
        id: guidanceId,
        type: "guidance",
        message,
        images,
        planModeEnabled: !!options?.planModeEnabled,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "accepted" || data.type === "guidance_done") {
          resolve();
        } else {
          reject(new Error(data.error || "Codex guidance failed"));
        }
      });
    });

    this.emitEvent({
      type: "process_event",
      entryType: "status",
      kind: "status",
      title: `收到引导: "${messagePreview || "用户引导"}"`,
      detail: displayMessage || undefined,
      state: "completed",
    });
  }

  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    if (!this.process) {
      return { supported: true, success: false, error: "Codex worker is not running" };
    }

    const requestId = this.createCommandId();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        resolve({ supported: true, success: false, error: "Codex fork timed out" });
      }, 30000);
      this.sendWorkerCommand({
        id: requestId,
        type: "forkSession",
        ...target,
        sourceSessionFilePath: target.sourceSessionFilePath || this._sessionFilePath || undefined,
      }, (data) => {
        clearTimeout(timeout);
        resolve({
          supported: data.supported !== false,
          success: !!data.success,
          sessionFilePath: data.sessionFilePath,
          nativeEntryId: data.nativeEntryId,
          error: data.error,
          reason: data.reason,
        });
      });
    });
  }

  async abort(): Promise<void> {
    this.isAborting = true;
    this.eventBuffer.clear();
    for (const [id, handler] of this.pendingResponses.entries()) {
      handler({ type: "error", id, error: "Codex request interrupted" });
    }
    this.pendingResponses.clear();
    this.activePromptIds.clear();
    if (!this.process) {
      this.emitEvent({ type: "aborted" });
      this.isAborting = false;
      return;
    }

    await new Promise<void>((resolve) => {
      let acknowledged = false;
      const timeout = setTimeout(() => {
        if (!acknowledged) this.emitEvent({ type: "aborted" });
        resolve();
      }, 5000);
      this.sendWorkerCommand({ type: "abort" }, () => {
        acknowledged = true;
        clearTimeout(timeout);
        resolve();
      });
    });
    this.isAborting = false;
  }

  async getModels(): Promise<AgentModel[]> {
    if (!this.process) return [];
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve([]), 4000);
      this.sendWorkerCommand({ type: "getModels" }, (data) => {
        clearTimeout(timeout);
        this.models = Array.isArray(data.models) ? data.models : [];
        resolve(this.models);
      });
    });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.sendWorkerCommand({ type: "setModel", provider, modelId }, (data) => {
      if (data.type === "model_changed") this.emitEvent({ type: "model_changed", model: data.model });
    });
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.sendWorkerCommand({ type: "setThinkingLevel", level }, (data) => {
      if (data.type === "thinking_level_changed") this.emitEvent({ type: "thinking_level_changed", level: data.level });
    });
  }

  sendUIResponse(response: any): void {
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id: response?.id,
        value: response?.value ?? response?.text,
        confirmed: response?.confirmed,
        cancelled: !!response?.cancelled,
        result: response?.result ?? (response?.answers ? { cancelled: false, answers: response.answers } : undefined),
      },
    });
  }

  dispose(): void {
    this.initPromise = null;
    this.initKey = null;
    this.pendingResponses.clear();
    this.activePromptIds.clear();
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin?.write(`${JSON.stringify({ type: "dispose" })}\n`);
      setTimeout(() => child.kill(), 500);
    }
  }

  private handleWorkerMessage(data: any) {
    if (data.id) {
      const handler = this.pendingResponses.get(data.id);
      if (handler) {
        this.pendingResponses.delete(data.id);
        handler(data);
      }
    }

    switch (data.type) {
      case "ready":
        for (const handler of this.pendingResponses.values()) handler(data);
        this.pendingResponses.clear();
        break;
      case "session_file_path":
        this._sessionFilePath = data.sessionFilePath || data.threadId || this._sessionFilePath;
        this.emitEvent({ type: "session_file_path", sessionFilePath: this._sessionFilePath, threadId: data.threadId });
        break;
      case "agent_start":
        this.emitEvent({ type: "agent_start" });
        break;
      case "stream_start":
        this.emitEvent({ type: "stream_start", role: data.role || "assistant" });
        break;
      case "stream_delta":
        this.emitEvent({ type: "stream_delta", delta: data.delta || "" });
        break;
      case "stream_snapshot":
        this.emitEvent({ type: "stream_snapshot", content: data.content || "" });
        break;
      case "stream_end":
        this.emitEvent({ type: "stream_end", content: data.content || "", force: data.force });
        break;
      case "thinking_delta":
        this.emitEvent({ type: "thinking_delta", delta: data.delta || "" });
        break;
      case "thinking_end":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "tool_start":
      case "tool_end":
      case "process_event":
      case "plan_update":
      case "context_compaction":
      case "diff_update":
        this.emitEvent(data);
        break;
      case "agent_end":
        this.activePromptIds.clear();
        this.emitEvent(data);
        break;
      case "prompt_done":
        if (data.id) this.activePromptIds.delete(String(data.id));
        else this.activePromptIds.clear();
        break;
      case "aborted":
        if (data.promptId) this.activePromptIds.delete(String(data.promptId));
        else this.activePromptIds.clear();
        this.emitEvent({ type: "aborted", promptId: data.promptId });
        break;
      case "error":
        if (data.id) this.activePromptIds.delete(String(data.id));
        else this.activePromptIds.clear();
        if (/Codex is already running/i.test(data.error || "")) {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            kind: "status",
            title: "Codex 仍在执行上一条请求",
            detail: "新的发送请求已忽略；当前 Codex 任务还在运行，后续输出会继续追加到当前处理中块。",
            state: "running",
          });
          break;
        }
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Codex 运行失败",
          detail: data.error || "Unknown error",
          state: "error",
        });
        break;
    }
  }

  private sendWorkerCommand(command: any, onResponse?: (data: any) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}\n`);
    return id;
  }

  private createCommandId(): string {
    return `codex-${++this.requestId}`;
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }
}
