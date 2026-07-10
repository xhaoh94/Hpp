import { BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { AgentEventBuffer } from "./agent-event-buffer";
import { buildDiffsFromToolEvent, isContextCompactionLike, normalizeQuestionProcessEvent, normalizeToolEvent, unwrapToolText } from "./process-events";
import { getBundledWorkerPath, getWorkerInvocation } from "../utils/worker-process";
import { getPiSDKUserRuntimeRoot } from "../utils/pi-sdk-runtime";
import type { AgentImagePayload, AgentUIResponse, UnknownRecord } from "../../src/types/ipc";
import { isRecord } from "../../src/types/ipc";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  permissionMode?: "plan" | "full-access";
  displayMessage?: string;
  clientMessageId?: string;
}

interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  targetTurnId?: string;
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

type WorkerCommand = UnknownRecord & {
  type: string;
  id?: string;
};

const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const normalizeModels = (value: unknown): AgentModel[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawModel) => {
    const model = asRecord(rawModel);
    const id = optionalString(model.id);
    const name = optionalString(model.name) || id;
    const provider = optionalString(model.provider);
    if (!id || !name || !provider) return [];
    return [{
      id,
      name,
      provider,
      reasoning: model.reasoning === true,
      supportsImages: typeof model.supportsImages === "boolean" ? model.supportsImages : undefined,
    }];
  });
};

const getWorkerPath = () => {
  return getBundledWorkerPath("pi-sdk-worker.mjs", __dirname);
};

const PI_WORKER_INIT_TIMEOUT_MS = 120_000;

export class PiSDKAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventBuffer: AgentEventBuffer;
  private pendingResponses = new Map<string, (data: UnknownRecord) => void>();
  private requestId = 0;
  private models: AgentModel[] = [];
  private pendingAssistantText = "";
  private streamedText = false;
  private streamedTextBuffer = "";
  private emittedAssistantTextSnapshot = "";
  private pendingUIRequestIds = new Set<string>();
  private turnFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private isAborting = false;
  private activePromptIds = new Set<string>();
  private turnActive = false;
  private turnToken = 0;
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
    this.emitEvent({ type: "agent_init", agentId: "pi" });

    const worker = getWorkerInvocation(getWorkerPath(), ["PI_NODE_PATH"], { packagedRuntime: "node" });
    const userRuntimeRoot = getPiSDKUserRuntimeRoot();
    const workerEnv = { ...worker.env, PI_SDK_PACKAGE_ROOT: userRuntimeRoot };
    const child = spawn(worker.command, worker.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnv,
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
      console.log("[pi-sdk-worker]", text.trim());
    });

    child.on("error", (error) => {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Pi 启动失败",
        detail: `${error.message}\n请确认系统 PATH 中的 node 版本 >= 22，或设置 PI_NODE_PATH 指向 Node 22。`,
        state: "error",
      });
      for (const handler of this.pendingResponses.values()) handler({ type: "error", error: error.message });
      this.pendingResponses.clear();
    });

    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      const exitReason = signal || (code ?? "unknown");
      const detail = getWorkerErrorDetail();
      const error = [
        `Pi SDK worker exited before completing the request (${exitReason})`,
        detail,
      ].filter(Boolean).join("\n");
      for (const handler of this.pendingResponses.values()) handler({ type: "error", error });
      this.pendingResponses.clear();
      this.activePromptIds.clear();
      this.pendingUIRequestIds.clear();
      if (!this.isAborting) {
        this.emitEvent({ type: "agent_disconnected" });
      }
    });

    const initPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(initId);
        reject(new Error("Pi SDK worker init timed out"));
      }, PI_WORKER_INIT_TIMEOUT_MS);
      const initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: existingSessionFilePath,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "ready") {
          this._sessionFilePath = optionalString(data.sessionFilePath) || existingSessionFilePath || null;
          this.emitEvent({ type: "agent_ready", agentId: "pi", mock: false });
          resolve();
        } else {
          reject(new Error(optionalString(data.error) || "Pi SDK worker init failed"));
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

  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting) this.finishAbortState();

    if (this.turnActive) {
      this.completeTurn(true);
    } else {
      this.prepareNewTurn();
    }

    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.beginTurn();
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
    return (
      !this.isAborting &&
      !this.turnActive &&
      this.activePromptIds.size === 0 &&
      this.pendingUIRequestIds.size === 0 &&
      this.pendingResponses.size === 0
    );
  }

  async sendGuidance(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting) this.finishAbortState();

    const guidanceId = this.createCommandId();
    const displayMessage = options?.displayMessage || message;
    const messagePreview = displayMessage.length > 50 ? `${displayMessage.slice(0, 50)}...` : displayMessage;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(guidanceId);
        reject(new Error("Pi SDK guidance timed out"));
      }, 12000);
      this.sendWorkerCommand({
        id: guidanceId,
        type: "guidance",
        message,
        images,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "accepted" || data.type === "guidance_done") {
          resolve();
        } else {
          reject(new Error(optionalString(data.error) || "Pi SDK guidance failed"));
        }
      });
    });
    this.emitEvent({
      type: "process_event",
      entryType: "status",
      title: `收到引导: "${messagePreview || "用户引导"}"`,
      detail: displayMessage || undefined,
      state: "completed",
    });
  }

  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    if (!this.process) {
      return { supported: true, success: false, error: "Pi SDK worker is not running" };
    }

    const requestId = this.createCommandId();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        resolve({ supported: true, success: false, error: "Pi SDK fork timed out" });
      }, 12000);
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
          sessionFilePath: optionalString(data.sessionFilePath),
          nativeEntryId: optionalString(data.nativeEntryId),
          error: optionalString(data.error),
          reason: optionalString(data.reason),
        });
      });
    });
  }

  async abort(): Promise<void> {
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.eventBuffer.clear();
    this.clearTurnFallback();
    this.emitEvent({ type: "thinking_end" });
    this.emitEvent({ type: "stream_end", content: "" });
    this.emitEvent({ type: "agent_end" });
    this.isAborting = true;

    if (!this.process) {
      this.finishAbortState();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      this.sendWorkerCommand({ type: "abort" }, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.finishAbortState();
  }

  async getModels(): Promise<AgentModel[]> {
    if (this.models.length > 0) return this.models;
    if (!this.process) return [];
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve([]), 4000);
      this.sendWorkerCommand({ type: "getModels" }, (data) => {
        clearTimeout(timeout);
        this.models = normalizeModels(data.models);
        resolve(this.models);
      });
    });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    let requestId = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        reject(new Error("Pi SDK set model timed out"));
      }, 8000);
      requestId = this.sendWorkerCommand({ type: "setModel", provider, modelId }, (data) => {
        clearTimeout(timeout);
        if (data.type === "model_changed") {
          this.emitEvent({ type: "model_changed", model: data.model });
          resolve();
          return;
        }
        reject(new Error(optionalString(data.error) || "Pi SDK set model failed"));
      });
    });
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.sendWorkerCommand({ type: "setThinkingLevel", level }, (data) => {
      if (data.type === "thinking_level_changed") this.emitEvent({ type: "thinking_level_changed", level: data.level });
    });
  }

  sendUIResponse(response: AgentUIResponse): void {
    const id = response.id;
    if (id) {
      this.pendingUIRequestIds.delete(String(id));
      if (this.pendingUIRequestIds.size === 0 && (this.pendingAssistantText || this.streamedText)) {
        this.scheduleTurnFallback(4000);
      }
    }
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id,
        value: response.value ?? response.text,
        confirmed: response.confirmed,
        cancelled: !!response.cancelled,
        result: response.result ?? (response.answers ? { cancelled: false, answers: response.answers } : undefined),
      },
    });
  }

  dispose(): void {
    this.initPromise = null;
    this.initKey = null;
    this.clearTurnFallback();
    this.pendingResponses.clear();
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.isAborting = false;
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin?.write(`${JSON.stringify({ type: "dispose" })}\n`);
      setTimeout(() => child.kill(), 500);
    }
  }

  private handleWorkerMessage(data: unknown) {
    const record = asRecord(data);
    const messageId = record.id !== undefined && record.id !== null ? String(record.id) : "";
    if (messageId) {
      const handler = this.pendingResponses.get(messageId);
      if (handler) {
        this.pendingResponses.delete(messageId);
        handler(record);
      }
    }

    switch (record.type) {
      case "context_compaction":
        this.emitEvent({ type: "context_compaction", id: record.id });
        break;
      case "ready":
        for (const handler of this.pendingResponses.values()) handler(record);
        this.pendingResponses.clear();
        break;
      case "agent_start":
        this.beginTurn();
        break;
      case "message_update": {
        if (!this.turnActive && this.activePromptIds.size > 0) this.beginTurn();
        if (!this.turnActive) break;
        this.clearTurnFallback();
        const assistantEvent = asRecord(record.assistantMessageEvent);
        if (assistantEvent.type === "text_delta") {
          const delta = String(assistantEvent.delta || "");
          if (delta) {
            this.streamedText = true;
            this.streamedTextBuffer += delta;
          }
          this.emitEventThrottled({ type: "stream_delta", delta });
        } else if (assistantEvent.type === "thinking_delta") {
          this.emitEventThrottled({ type: "thinking_delta", delta: String(assistantEvent.delta || "") });
        }
        break;
      }
      case "message_end":
        if (!this.turnActive && this.activePromptIds.size === 0) break;
        if (!this.turnActive) this.beginTurn();
        {
          const message = asRecord(record.message);
          if (message.role !== "assistant") break;
          if (message.thinking) this.emitEvent({ type: "thinking_end" });
          const stopReason = String(message.stopReason || "");
          const errorMessage = String(message.errorMessage || "").trim();
          if (stopReason === "error" || errorMessage) {
            this.pendingAssistantText = "";
            this.streamedText = false;
            this.streamedTextBuffer = "";
            this.emittedAssistantTextSnapshot = "";
            this.pendingUIRequestIds.clear();
            this.activePromptIds.clear();
            this.clearTurnFallback();
            this.emitEvent({
              type: "process_event",
              entryType: "error",
              kind: "error",
              title: "模型请求失败",
              detail: errorMessage || `Assistant stopped with reason: ${stopReason || "error"}`,
              state: "error",
            });
            this.completeTurn(true);
            break;
          }
          if (typeof message.text === "string" && message.text) {
            this.pendingAssistantText = message.text;
            this.emitPendingAssistantText();
            if (this.pendingUIRequestIds.size === 0) {
              this.scheduleTurnFallback(4000, true);
            }
          }
        }
        break;
      case "tool_execution_start":
        this.clearTurnFallback();
        this.emitEvent(normalizeToolEvent("tool_start", { ...record, args: record.args, name: record.toolName }));
        break;
      case "tool_execution_update": {
        const detail = unwrapToolText(record.partialResult);
        if (detail) {
          this.emitEvent(normalizeToolEvent("tool_start", {
            ...record,
            args: record.args,
            result: record.partialResult,
            detail,
            name: record.toolName,
          }));
        }
        break;
      }
      case "tool_execution_end": {
        const toolEvent = normalizeToolEvent("tool_end", {
          ...record,
          args: record.args,
          result: record.result,
          output: record.result,
          name: record.toolName,
        });
        this.emitEvent(toolEvent);
        const diffs = buildDiffsFromToolEvent(toolEvent);
        if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        break;
      }
      case "extension_ui_request":
        this.handleUIRequest(record.request);
        break;
      case "prompt_done":
        if (messageId && !this.activePromptIds.delete(messageId)) break;
        if (!messageId) this.activePromptIds.clear();
        this.pendingUIRequestIds.clear();
        this.completeTurn(true);
        break;
      case "agent_end":
        if (this.activePromptIds.size === 0) this.scheduleTurnFallback(250, true);
        break;
      case "error":
        if (messageId && !this.activePromptIds.delete(messageId)) break;
        if (isContextCompactionLike(record.error, record.title, record.message)) {
          this.emitEvent({ type: "context_compaction", id: record.id });
          break;
        }
        this.pendingUIRequestIds.clear();
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Pi 运行失败",
          detail: record.error || "Unknown error",
          state: "error",
        });
        this.completeTurn(true);
        break;
    }
  }

  private handleUIRequest(request: unknown) {
    const requestRecord = asRecord(request);
    const method = optionalString(requestRecord.method) || "";
    if (!method || method === "notify") return;
    const requestId = requestRecord.id !== undefined && requestRecord.id !== null ? String(requestRecord.id) : "";
    if (!requestId) return;
    const kind = optionalString(requestRecord.kind) || "";
    const title =
      method === "custom" && kind === "ask_user_question"
        ? "请选择答案"
        : optionalString(requestRecord.title) || optionalString(requestRecord.message) || "正在询问用户";
    this.pendingUIRequestIds.add(requestId);
    this.clearTurnFallback();
    this.emitPendingAssistantText();
    this.emitEvent(normalizeQuestionProcessEvent({
      type: "extension_ui_request",
      id: requestId,
      requestId,
      method: method === "custom" ? kind : method,
      title,
      detail: request,
      questions: method === "custom" ? requestRecord.questions : undefined,
      toolName: requestRecord.toolName,
      state: "running",
    }));
  }

  private sendWorkerCommand(command: WorkerCommand, onResponse?: (data: UnknownRecord) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}\n`);
    return id;
  }

  private createCommandId(): string {
    return `sdk-${++this.requestId}`;
  }

  private clearTurnFallback() {
    if (this.turnFallbackTimer) {
      clearTimeout(this.turnFallbackTimer);
      this.turnFallbackTimer = null;
    }
  }

  private scheduleTurnFallback(delayMs: number, force = false) {
    if (!force && this.pendingUIRequestIds.size > 0) return;
    this.clearTurnFallback();
    const token = this.turnToken;
    this.turnFallbackTimer = setTimeout(() => {
      this.turnFallbackTimer = null;
      if (token !== this.turnToken) return;
      if (force || this.pendingAssistantText || this.streamedText) this.completeTurn(force);
    }, delayMs);
  }

  private beginTurn() {
    this.clearTurnFallback();
    if (this.turnActive) return;
    this.turnToken += 1;
    this.turnActive = true;
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.pendingAssistantText = "";
    this.emitEvent({ type: "stream_start", role: "assistant" });
  }

  private completeTurn(force = false) {
    if (!this.turnActive) return;
    if (force) {
      this.pendingUIRequestIds.clear();
      this.activePromptIds.clear();
    }
    if (this.pendingUIRequestIds.size > 0) return;
    if (this.activePromptIds.size > 0) return;
    this.clearTurnFallback();
    this.eventBuffer.flush();
    this.emitPendingAssistantText();
    this.emitEvent({ type: "stream_end", content: this.pendingAssistantText, force });
    this.emitEvent({ type: "agent_end" });
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.turnActive = false;
    this.turnToken += 1;
  }

  private emitPendingAssistantText() {
    if (!this.pendingAssistantText || this.emittedAssistantTextSnapshot === this.pendingAssistantText) return;

    if (!this.streamedText) {
      this.emitEvent({ type: "stream_delta", delta: this.pendingAssistantText });
      this.streamedTextBuffer = this.pendingAssistantText;
      this.streamedText = true;
    } else if (this.streamedTextBuffer !== this.pendingAssistantText) {
      this.emitEvent({ type: "stream_snapshot", content: this.pendingAssistantText });
      this.streamedTextBuffer = this.pendingAssistantText;
    }

    this.emittedAssistantTextSnapshot = this.pendingAssistantText;
  }

  private prepareNewTurn() {
    this.clearTurnFallback();
    this.eventBuffer.flush();
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.turnToken += 1;
  }

  private finishAbortState() {
    this.isAborting = false;
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.emittedAssistantTextSnapshot = "";
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.turnToken += 1;
    this.eventBuffer.clear();
    this.clearTurnFallback();
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  private emitEventThrottled(data: { type: string; [key: string]: unknown }) {
    this.eventBuffer.send(data);
  }
}
