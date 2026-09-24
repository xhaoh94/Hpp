import { execFile, spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import { normalizeQuestionProcessEvent } from "../../plugin-runtime/process-events";
import { getPluginWorkerInvocation } from "../../plugin-runtime/plugin-worker-runtime";
import { ToolFileDiffFallback, type ToolFileTarget } from "../../plugin-runtime/turn-file-diff";
import { loadCodexHistorySnapshot } from "./history";
import type {
  AgentActionCatalogEntry,
  AgentActionInvocation,
  AgentActionListOptions,
  AgentImagePayload,
  AgentUIResponse,
  UnknownRecord,
} from "../../../src/types/ipc";
import { isRecord } from "../../../src/types/ipc";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
  hostSystemPrompt?: string;
  permissionMode?: import("../../../shared/agent-permissions").AgentPermissionMode;
  clientMessageId?: string;
  action?: AgentActionInvocation;
}

interface AgentInitOptions {
  hostSystemPrompt?: string;
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
      contextWindow: Number.isFinite(Number(model.contextWindow)) && Number(model.contextWindow) > 0
        ? Number(model.contextWindow)
        : undefined,
      supportsImages: typeof model.supportsImages === "boolean" ? model.supportsImages : undefined,
      supportedThinkingLevels: Array.isArray(model.supportedThinkingLevels)
        ? model.supportedThinkingLevels.filter((level): level is string => typeof level === "string")
        : undefined,
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
  // A closed stdout pipe does not guarantee that the worker has exited.
  // Retain ownership until dispose() can reap that child and its descendants.
  private processForCleanup: ChildProcess | null = null;
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
  private hostSystemPrompt = "";
  private guidancePendingId: string | null = null;
  private readonly toolFileDiffFallback = new ToolFileDiffFallback();

  constructor(hppSessionId = "default", emit?: (event: UnknownRecord) => void) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  get sessionFilePath(): string | null {
    return this._sessionFilePath;
  }

  async init(projectPath: string, existingSessionFilePath?: string, options?: AgentInitOptions): Promise<void> {
    const requestedSessionFilePath = existingSessionFilePath || null;
    const requestedHostSystemPrompt = String(options?.hostSystemPrompt || "").trim();
    const nextInitKey = `${projectPath}\n${requestedSessionFilePath || ""}\n${requestedHostSystemPrompt}`;
    if (this.initPromise && this.initKey === nextInitKey) {
      return this.initPromise;
    }

    if (
      this.process &&
      this.projectPath === projectPath &&
      this.hostSystemPrompt === requestedHostSystemPrompt &&
      this._sessionFilePath === (existingSessionFilePath || this._sessionFilePath)
    ) {
      await this.emitRecoveredHistory(existingSessionFilePath);
      return;
    }

    this.initKey = nextInitKey;
    await this.dispose();
    this.initKey = nextInitKey;
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.hostSystemPrompt = requestedHostSystemPrompt;
    this.emitEvent({ type: "agent_init", agentId: "codex" });

    const worker = getPluginWorkerInvocation("codex-worker.mjs", ["CODEX_NODE_PATH", "PI_NODE_PATH"]);
    const child = spawn(worker.command, worker.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: worker.env,
      windowsHide: true,
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
          this.handleWorkerMessage(JSON.parse(line), child);
        } catch {
          // Ignore non-protocol output from dependencies.
        }
      }
    });
    child.stdout?.on("end", () => {
      this.handleWorkerTermination(
        child,
        "Codex worker disconnected",
        "Codex worker output pipe closed before the process exited.",
      );
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText = `${stderrText}${text}`.slice(-4000);
      console.log("[codex-worker]", text.trim());
    });

    child.stdin?.on("error", (error) => {
      this.handleWorkerTermination(
        child,
        "Codex worker input failed",
        `Codex worker input pipe closed: ${error.message}`,
      );
    });

    child.on("error", (error) => {
      this.handleWorkerTermination(
        child,
        "Codex worker failed",
        `${error.message}\n请确认系统 PATH 中的 node 版本 >= 18，或设置 CODEX_NODE_PATH 指向 Node 18+。`,
      );
    });

    child.on("exit", (code, signal) => {
      const exitReason = signal || (code ?? "unknown");
      const detail = getWorkerErrorDetail();
      this.handleWorkerTermination(child, "Codex worker disconnected", [
        `Codex worker exited before completing the request (${exitReason})`,
        detail,
      ].filter(Boolean).join("\n"));
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
        hostSystemPrompt: this.hostSystemPrompt,
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
    this.guidancePendingId = null;
    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    try {
      this.sendWorkerCommand({
        id: promptId,
        type: "prompt",
        message,
        images,
        planModeEnabled: !!options?.planModeEnabled,
        permissionMode: options?.permissionMode || "auto",
        hostSystemPrompt: options?.hostSystemPrompt,
        action: options?.action,
      });
    } catch (error) {
      this.activePromptIds.delete(promptId);
      this.emitPromptFailure(
        "Codex 请求发送失败",
        error instanceof Error ? error.message : String(error),
        this.activePromptIds.size === 0,
      );
      throw error;
    }
  }

  isIdle(): boolean {
    // pendingResponses also contains short-lived model/action/config RPCs.
    // Those requests are not an active conversation turn and must not keep
    // agent:getSessionState reporting busy after the prompt has completed.
    return !this.isAborting && this.activePromptIds.size === 0;
  }

  async sendGuidance(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Codex worker is not running");
    const guidanceId = this.createCommandId();

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
        hostSystemPrompt: options?.hostSystemPrompt,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "guidance_done") {
          this.guidancePendingId = guidanceId;
          resolve();
        } else {
          reject(new Error(optionalString(data.error) || "Codex guidance failed"));
        }
      });
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
    this.guidancePendingId = null;
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

    try {
      await new Promise<void>((resolve) => {
        let acknowledged = false;
        const timeout = setTimeout(() => {
          if (!acknowledged) this.emitEvent({ type: "aborted" });
          resolve();
        }, 5000);
        try {
          this.sendWorkerCommand({ type: "abort" }, (data) => {
            acknowledged = true;
            clearTimeout(timeout);
            if (data.type === "error") {
              this.emitEvent({ type: "aborted", detail: optionalString(data.error) });
            }
            resolve();
          });
        } catch (error) {
          clearTimeout(timeout);
          this.emitEvent({
            type: "aborted",
            detail: error instanceof Error ? error.message : String(error),
          });
          resolve();
        }
      });
    } finally {
      this.isAborting = false;
    }
  }

  async getModels(): Promise<AgentModel[]> {
    if (!this.process) return [];
    return new Promise((resolve) => {
      let requestId = "";
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        resolve([]);
      }, 4000);
      requestId = this.sendWorkerCommand({ type: "getModels" }, (data) => {
        clearTimeout(timeout);
        this.models = normalizeModels(data.models);
        resolve(this.models);
      });
    });
  }

  async listActions(options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]> {
    if (!this.process) return [];
    return new Promise((resolve) => {
      let requestId = "";
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        resolve([]);
      }, 15000);
      requestId = this.sendWorkerCommand({ type: "listActions", reload: options?.reload === true }, (data) => {
        clearTimeout(timeout);
        resolve(Array.isArray(data.actions) ? data.actions as AgentActionCatalogEntry[] : []);
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

  async sendUIResponse(response: AgentUIResponse): Promise<void> {
    const id = optionalString(response.id) || optionalString(response.requestId);
    const data = await this.requestWorkerCommand({
      type: "uiResponse",
      response: {
        id,
        value: response.value ?? response.text,
        confirmed: response.confirmed,
        cancelled: !!response.cancelled,
        result: response.result ?? (response.answers ? { cancelled: false, answers: response.answers } : undefined),
      },
    }, 12_000);
    if (data.type !== "ui_response_done") {
      throw new Error(optionalString(data.error) || "Codex UI response failed");
    }
  }

  async dispose(): Promise<void> {
    this.initPromise = null;
    this.initKey = null;
    const wasActive = this.activePromptIds.size > 0;
    for (const [id, handler] of this.pendingResponses.entries()) {
      handler({ type: "error", id, error: "Codex backend disposed" });
    }
    this.pendingResponses.clear();
    this.activePromptIds.clear();
    this.guidancePendingId = null;
    this.isAborting = false;
    if (wasActive) {
      this.emitEvent({ type: "stream_end", content: "", force: true });
      this.emitEvent({ type: "agent_end" });
    } else {
      this.eventBuffer.flush();
    }
    const child = this.process || this.processForCleanup;
    this.process = null;
    this.processForCleanup = null;
    if (!child) return;
    this.intentionalExits.add(child);
    if (child.stdin?.writable) {
      try {
        child.stdin.write(`${JSON.stringify({ type: "dispose" })}\n`);
      } catch {
        // Continue with process-tree termination below.
      }
    }
    if (await this.waitForExit(child, 1500)) return;
    await this.killProcessTree(child);
    await this.waitForExit(child, 500);
  }

  private handleWorkerMessage(data: unknown, sourceChild?: ChildProcess) {
    if (sourceChild && this.process !== sourceChild) return;
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
      case "token_usage": {
        const inputTokens = Number(record.inputTokens) || 0;
        const outputTokens = Number(record.outputTokens) || 0;
        const cacheInputTokens = Number(record.cacheInputTokens) || 0;
        // worker 把 last.inputTokens 这个绝对值当上下文占用一起报上来；缺失时退回本次增量。
        const contextTokens = Number(record.contextTokens) || inputTokens;
        const contextWindow = Number(record.contextWindow) || 0;
        if (inputTokens > 0 || outputTokens > 0) {
          this.emitEvent({
            type: "token_usage",
            inputTokens,
            outputTokens,
            cacheInputTokens,
            contextTokens,
            ...(contextWindow > 0 ? { contextWindow } : {}),
            contextPrecision: "official",
          });
        }
        break;
      }
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
        // 回合起点：清掉上一轮的快照缓存，避免沿用过期 baseline。
        this.toolFileDiffFallback.reset();
        this.emitEvent({ type: "agent_start" });
        break;
      // The worker correlates this event with the delayed userMessage item
      // whose client id was supplied to turn/steer. That item appears after
      // the previous model response and immediately before Codex processes the
      // guidance, rather than at RPC acceptance time.
      case "guidance_delivered":
        if (
          this.guidancePendingId &&
          (!messageId || messageId === this.guidancePendingId)
        ) {
          this.guidancePendingId = null;
          this.emitEvent({ type: "guidance_response_started" });
        }
        break;
      case "stream_start":
        this.emitEvent({ type: "stream_start", role: record.role || "assistant" });
        break;
      case "stream_delta":
        this.emitEvent({ type: "stream_delta", delta: String(record.delta || "") });
        break;
      case "commentary_delta":
        this.emitEvent({
          type: "commentary_delta",
          itemId: optionalString(record.itemId),
          delta: String(record.delta || ""),
        });
        break;
      case "commentary_end":
        this.emitEvent({
          type: "commentary_end",
          itemId: optionalString(record.itemId),
          content: String(record.content || ""),
        });
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
        // 工具刚开始执行、文件尚未被改写——此刻抓到的才是「修改前」快照。
        this.forEachCodexFileTarget(record, (target) => {
          this.toolFileDiffFallback.onToolStart(this.projectPath, target);
        });
        this.emitEvent(record);
        break;
      case "tool_end":
        // 工具结束后读一次磁盘，算出「修改前 → 当前」的真实差异；provider
        // 补丁不可用或对不上时，它就是唯一可靠的撤销依据。
        this.forEachCodexFileTarget(record, (target) => {
          this.toolFileDiffFallback.resolve(this.projectPath, target);
        });
        this.emitEvent(record);
        break;
      case "subagent_event":
      case "plan_update":
      case "context_compaction":
        this.emitEvent(record);
        break;
      case "diff_update": {
        // 兜底补丁由磁盘真实字节算出、反向必然可应用；provider 的累计快照可能
        // 基于过期上下文（行号/行尾都可能对不上），同一文件以兜底为准。
        const providerDiffs = (Array.isArray(record.diffs) ? record.diffs : []) as Array<{ file: string }>;
        const diffs = this.toolFileDiffFallback.mergeWithProviderDiffs(
          providerDiffs,
          (file) => this.diffFileKey(file),
        );
        // 兜底缓存是「回合起点 → 当前磁盘」的累计快照，只在本回合结算用一次。
        this.toolFileDiffFallback.reset();
        this.emitEvent({ ...record, diffs });
        break;
      }
      case "process_event":
        this.emitEvent(isQuestionProcessEvent(record) ? normalizeCodexQuestionEvent(record) : record);
        break;
      case "agent_end":
        this.activePromptIds.clear();
        this.guidancePendingId = null;
        this.emitEvent(record);
        break;
      case "prompt_done":
        if (messageId) this.activePromptIds.delete(messageId);
        else this.activePromptIds.clear();
        break;
      case "aborted":
        if (record.promptId) this.activePromptIds.delete(String(record.promptId));
        else this.activePromptIds.clear();
        this.guidancePendingId = null;
        this.emitEvent({ type: "aborted", promptId: record.promptId });
        break;
      case "agent_disconnected":
        this.activePromptIds.clear();
        this.guidancePendingId = null;
        this.emitEvent({
          type: "agent_disconnected",
          detail: optionalString(record.detail) || optionalString(record.error),
        });
        break;
      case "error":
        // Worker control RPCs share this channel with prompt failures. An
        // error for a model/action/config request must not terminate a
        // different active conversation turn.
        if (messageId && !this.activePromptIds.has(messageId)) break;
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
        this.guidancePendingId = null;
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Codex 运行失败",
          detail: record.error || "Unknown error",
          state: "error",
        });
        if (this.activePromptIds.size === 0) {
          this.emitEvent({ type: "stream_end", content: "", force: true });
          this.emitEvent({ type: "agent_end" });
        }
        break;
    }
  }

  private sendWorkerCommand(command: WorkerCommand, onResponse?: (data: UnknownRecord) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    const child = this.process;
    if (!child?.stdin?.writable) throw new Error("Codex worker is not writable");
    if (onResponse) this.pendingResponses.set(id, onResponse);
    try {
      child.stdin.write(`${JSON.stringify(fullCommand)}\n`);
    } catch (error) {
      this.pendingResponses.delete(id);
      throw error;
    }
    return id;
  }

  private requestWorkerCommand(command: WorkerCommand, timeoutMs: number): Promise<UnknownRecord> {
    return new Promise((resolve, reject) => {
      let id = "";
      const timeout = setTimeout(() => {
        if (id) this.pendingResponses.delete(id);
        reject(new Error(`Codex ${command.type} timed out`));
      }, timeoutMs);
      try {
        id = this.sendWorkerCommand(command, (data) => {
          clearTimeout(timeout);
          if (data.type === "error") reject(new Error(optionalString(data.error) || `${command.type} failed`));
          else resolve(data);
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private createCommandId(): string {
    return `codex-${++this.requestId}`;
  }

  private handleWorkerTermination(child: ChildProcess, title: string, detail: string): void {
    if (this.process !== child) return;
    this.processForCleanup = child;
    this.process = null;
    const wasActive = this.activePromptIds.size > 0;
    const intentional = this.intentionalExits.has(child);
    const handlers = [...this.pendingResponses.values()];
    this.pendingResponses.clear();
    for (const handler of handlers) handler({ type: "error", error: detail });
    this.activePromptIds.clear();
    this.guidancePendingId = null;
    if (intentional || this.isAborting) return;
    if (wasActive) {
      this.emitPromptFailure(title, detail, true);
    } else {
      this.emitEvent({ type: "agent_disconnected", detail });
    }
  }

  private emitPromptFailure(title: string, detail: string, finishTurn: boolean): void {
    this.emitEvent({
      type: "process_event",
      entryType: "error",
      kind: "error",
      title,
      detail,
      state: "error",
    });
    if (!finishTurn) return;
    this.emitEvent({ type: "stream_end", content: "", force: true });
    this.emitEvent({ type: "agent_end" });
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

  /**
   * codex 的 file_change 一次可涉及多个文件（apply_patch 批量改），事件里只用
   * files[{ file, label }] 给路径。兜底跟踪器按单文件调用，这里逐个喂进去；
   * 重复路径幂等——基线只记本轮最早一次，差异按文件去重。
   */
  private forEachCodexFileTarget(
    event: UnknownRecord,
    run: (target: ToolFileTarget) => void,
  ): void {
    const toolKind = String(event.toolKind || "");
    const files = Array.isArray(event.files) ? event.files : [];
    for (const raw of files) {
      const filePath = String(asRecord(raw).file || "").trim();
      if (filePath) run({ toolKind, filePath });
    }
  }

  /**
   * 兜底差异按 POSIX 项目相对路径命名，而 provider 在 Windows 上可能给
   * `src\a.ts`（path.relative 的产物）或项目内的绝对路径，比较前统一形式。
   */
  private diffFileKey(file: string): string {
    const posix = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const prefix = this.projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!prefix) return posix;
    return posix.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
      ? posix.slice(prefix.length + 1)
      : posix;
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }
}
