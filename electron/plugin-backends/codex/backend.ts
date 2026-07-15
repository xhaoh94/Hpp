import { execFile, spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import { normalizeQuestionProcessEvent } from "../../plugin-runtime/process-events";
import { getPluginWorkerInvocation } from "../../plugin-runtime/plugin-worker-runtime";
import { loadCodexHistorySnapshot } from "./history";
import type { AgentImagePayload, AgentUIResponse, UnknownRecord } from "../../../src/types/ipc";
import { isRecord } from "../../../src/types/ipc";

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

const isQuestionProcessEvent = (record: UnknownRecord): boolean => {
  const kind = String(record.entryType || record.kind || record.mode || record.toolKind || "");
  return kind === "question";
};

const normalizeCodexQuestionEvent = (record: UnknownRecord): UnknownRecord => {
  const prompt = record.prompt || record.question || record.message;
  const title = prompt ? undefined : record.title;
  return normalizeQuestionProcessEvent({ ...record, title }) as UnknownRecord;
};

const CODEX_WORKER_INIT_TIMEOUT_MS = 120_000;

export class CodexAgent {
  private process: ChildProcess | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventBuffer: AgentEventBuffer;
  private pendingResponses = new Map<string, (data: UnknownRecord) => void>();
  private requestId = 0;
  private models: AgentModel[] = [];
  private isAborting = false;
  private activePromptIds = new Set<string>();
  private initPromise: Promise<void> | null = null;
  private initKey: string | null = null;
  private intentionalExits = new WeakSet<ChildProcess>();

  constructor(hppSessionId = "default", emit?: (event: UnknownRecord) => void) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  get sessionFilePath(): string | null {
    return this._sessionFilePath;
  }

  async init(projectPath: string, existingSessionFilePath?: string): Promise<void> {
    const requestedSessionFilePath = existingSessionFilePath || null;
    const nextInitKey = `${projectPath}\n${requestedSessionFilePath || ""}`;
    if (this.initPromise && this.initKey === nextInitKey) {
      return this.initPromise;
    }

    if (this.process && this.projectPath === projectPath && this._sessionFilePath === (existingSessionFilePath || this._sessionFilePath)) {
      await this.emitRecoveredHistory(existingSessionFilePath);
      return;
    }

    this.initKey = nextInitKey;
    await this.dispose();
    this.initKey = nextInitKey;
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.emitEvent({ type: "agent_init", agentId: "codex" });

    const worker = getPluginWorkerInvocation("codex-worker.mjs", ["CODEX_NODE_PATH", "PI_NODE_PATH"]);
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
      if (!this.intentionalExits.has(child) && !this.isAborting) {
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
          this._sessionFilePath = optionalString(data.sessionFilePath) || existingSessionFilePath || null;
          resolve();
        } else {
          reject(new Error(optionalString(data.error) || "Codex worker init failed"));
        }
      });
    });
    this.initPromise = initPromise;
    try {
      await initPromise;
      await this.emitRecoveredHistory(existingSessionFilePath);
      this.emitEvent({ type: "agent_ready", agentId: "codex", mock: false });
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
        this.initKey = null;
      }
    }
  }

  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
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

  async sendGuidance(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
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
          reject(new Error(optionalString(data.error) || "Codex guidance failed"));
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
          sessionFilePath: optionalString(data.sessionFilePath),
          nativeEntryId: optionalString(data.nativeEntryId),
          error: optionalString(data.error),
          reason: optionalString(data.reason),
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
        this.models = normalizeModels(data.models);
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

  sendUIResponse(response: AgentUIResponse): void {
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id: response.id,
        value: response.value ?? response.text,
        confirmed: response.confirmed,
        cancelled: !!response.cancelled,
        result: response.result ?? (response.answers ? { cancelled: false, answers: response.answers } : undefined),
      },
    });
  }

  async dispose(): Promise<void> {
    this.initPromise = null;
    this.initKey = null;
    for (const [id, handler] of this.pendingResponses.entries()) {
      handler({ type: "error", id, error: "Codex backend disposed" });
    }
    this.pendingResponses.clear();
    this.activePromptIds.clear();
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (!child) return;
    this.intentionalExits.add(child);
    if (child.stdin?.writable) {
      child.stdin.write(`${JSON.stringify({ type: "dispose" })}\n`);
    }
    if (await this.waitForExit(child, 1500)) return;
    await this.killProcessTree(child);
    await this.waitForExit(child, 500);
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
      case "ready":
        for (const handler of this.pendingResponses.values()) handler(record);
        this.pendingResponses.clear();
        break;
      case "session_file_path":
        this._sessionFilePath = optionalString(record.sessionFilePath) || optionalString(record.threadId) || this._sessionFilePath;
        this.emitEvent({ type: "session_file_path", sessionFilePath: this._sessionFilePath, threadId: record.threadId });
        break;
      case "turn_metadata": {
        const nativeTurnId = optionalString(record.nativeTurnId) || optionalString(record.turnId);
        if (nativeTurnId) {
          this.emitEvent({
            type: "turn_metadata",
            nativeTurnId,
            turnId: nativeTurnId,
            clientUserMessageId: optionalString(record.clientUserMessageId),
            threadId: optionalString(record.threadId),
          });
        }
        break;
      }
      case "agent_start":
        this.emitEvent({ type: "agent_start" });
        break;
      case "stream_start":
        this.emitEvent({ type: "stream_start", role: record.role || "assistant" });
        break;
      case "stream_delta":
        this.emitEvent({ type: "stream_delta", delta: String(record.delta || "") });
        break;
      case "stream_snapshot":
        this.emitEvent({ type: "stream_snapshot", content: String(record.content || "") });
        break;
      case "stream_end":
        this.emitEvent({ type: "stream_end", content: String(record.content || ""), force: record.force });
        break;
      case "thinking_delta":
        this.emitEvent({ type: "thinking_delta", delta: String(record.delta || "") });
        break;
      case "thinking_end":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "tool_start":
      case "tool_end":
      case "plan_update":
      case "context_compaction":
      case "diff_update":
        this.emitEvent(record);
        break;
      case "process_event":
        this.emitEvent(isQuestionProcessEvent(record) ? normalizeCodexQuestionEvent(record) : record);
        break;
      case "agent_end":
        this.activePromptIds.clear();
        this.emitEvent(record);
        break;
      case "prompt_done":
        if (messageId) this.activePromptIds.delete(messageId);
        else this.activePromptIds.clear();
        break;
      case "aborted":
        if (record.promptId) this.activePromptIds.delete(String(record.promptId));
        else this.activePromptIds.clear();
        this.emitEvent({ type: "aborted", promptId: record.promptId });
        break;
      case "error":
        if (messageId) this.activePromptIds.delete(messageId);
        else this.activePromptIds.clear();
        if (/Codex is already running/i.test(String(record.error || ""))) {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            kind: "status",
            title: "Codex 仍在执行上一条请求",
            detail: "新的发送请求已忽略；当前 Codex 任务还在运行，后续输出会继续追加到当前处理中块。",
            state: "running",
            reason: "already-running",
          });
          break;
        }
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Codex 运行失败",
          detail: record.error || "Unknown error",
          state: "error",
        });
        break;
    }
  }

  private sendWorkerCommand(command: WorkerCommand, onResponse?: (data: UnknownRecord) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}\n`);
    return id;
  }

  private createCommandId(): string {
    return `codex-${++this.requestId}`;
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

  private async killProcessTree(child: ChildProcess): Promise<void> {
    if (process.platform !== "win32" || !child.pid) {
      child.kill("SIGKILL");
      return;
    }
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
  }

  private async emitRecoveredHistory(sessionFilePath?: string): Promise<void> {
    if (!sessionFilePath) return;
    try {
      const messages = await loadCodexHistorySnapshot(sessionFilePath);
      if (messages.length > 0) {
        this.emitEvent({ type: "history_snapshot", messages });
      }
    } catch (error: unknown) {
      console.warn("[codex-history] Failed to recover session history:", error);
    }
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }
}
