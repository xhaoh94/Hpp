import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import type {
  AgentActionCatalogEntry,
  AgentActionInvocation,
  AgentActionListOptions,
  AgentImagePayload,
  AgentUIResponse,
  UnknownRecord,
} from "../../../src/types/ipc";
import { isRecord } from "../../../src/types/ipc";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import {
  buildDiffsFromToolEvent,
  normalizeQuestionProcessEvent,
  normalizeToolEvent,
  unwrapToolText,
} from "../../plugin-runtime/process-events";
import { getPluginWorkerInvocation } from "../../plugin-runtime/plugin-worker-runtime";

export interface ClaudeBackendContext {
  getConfigState?: () => Promise<unknown>;
  dataDir?: string;
  pluginDir?: string;
}

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  permissionMode?: "plan" | "full-access";
  displayMessage?: string;
  clientMessageId?: string;
  action?: AgentActionInvocation;
}

interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  targetTurnId?: string;
}

interface AgentForkResult {
  supported: boolean;
  success: boolean;
  sessionFilePath?: string;
  nativeEntryId?: string;
  error?: string;
  reason?: string;
}

type WorkerCommand = UnknownRecord & { type: string; id?: string };

const CLAUDE_WORKER_INIT_TIMEOUT_MS = 120_000;
const CLAUDE_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"];
const FORK_DESCRIPTOR_PREFIX = "hpp-claude-fork:v1:";

const asRecord = (value: unknown): UnknownRecord => isRecord(value) ? value : {};
const optionalString = (value: unknown) => typeof value === "string" && value ? value : undefined;

function createForkDescriptor(sourceSessionId: string, targetMessageId: string, newSessionId: string) {
  const payload = Buffer.from(JSON.stringify({ sourceSessionId, targetMessageId, newSessionId }), "utf8").toString("base64url");
  return `${FORK_DESCRIPTOR_PREFIX}${payload}`;
}

function normalizeModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawModel) => {
    const model = asRecord(rawModel);
    const id = optionalString(model.id);
    const provider = optionalString(model.provider);
    if (!id || !provider) return [];
    return [{
      id,
      name: optionalString(model.name) || id,
      provider,
      reasoning: model.reasoning !== false,
      supportsImages: model.supportsImages !== false,
      supportedThinkingLevels: CLAUDE_THINKING_LEVELS,
    }];
  });
}

export class ClaudeSDKAgent {
  private process: ChildProcess | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private readonly eventBuffer: AgentEventBuffer;
  private readonly context?: ClaudeBackendContext;
  private pendingResponses = new Map<string, (data: UnknownRecord) => void>();
  private pendingUIRequestIds = new Set<string>();
  private requestId = 0;
  private activePromptId: string | null = null;
  private turnActive = false;
  private streamedText = false;
  private isReady = false;
  private models: AgentModel[] = [];
  private secretValues: string[] = [];

  constructor(sessionId = "default", emit?: (event: UnknownRecord) => void, context?: ClaudeBackendContext) {
    this.eventBuffer = new AgentEventBuffer(sessionId, emit);
    this.context = context;
  }

  get sessionFilePath() {
    return this._sessionFilePath;
  }

  async init(projectPath: string, existingSessionFilePath?: string): Promise<void> {
    const isNewSession = !existingSessionFilePath;
    await this.dispose();
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || randomUUID();
    this.emitEvent({ type: "agent_init", agentId: "claude" });
    const config = await this.context?.getConfigState?.();
    const configRecord = asRecord(config);
    const providers = Array.isArray(configRecord.providers) ? configRecord.providers.map(asRecord) : [];
    this.secretValues = providers.map((provider) => optionalString(provider.apiKey)).filter((value): value is string => !!value);

    const worker = getPluginWorkerInvocation("claude-sdk-worker.mjs", ["CLAUDE_NODE_PATH"], true);
    const runtimeRoot = join(this.context?.dataDir || process.env.HPP_DATA_DIR || process.cwd(), "claude-agent-sdk-runtime");
    const child = spawn(worker.command, worker.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...worker.env, CLAUDE_AGENT_SDK_PACKAGE_ROOT: runtimeRoot },
    });
    this.process = child;

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let stderrText = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { this.handleWorkerMessage(JSON.parse(line)); } catch { /* dependency output */ }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = this.redact(chunk.toString());
      stderrText = `${stderrText}${text}`.slice(-4000);
      console.log("[claude-sdk-worker]", text.trim());
    });
    child.on("error", (error) => this.handleWorkerTermination(child, `Claude Code 启动失败：${error.message}`));
    child.on("exit", (code, signal) => this.handleWorkerTermination(
      child,
      `Claude Agent SDK worker 已退出（${signal || (code ?? "unknown")}）${stderrText.trim() ? `\n${stderrText.trim().slice(-1500)}` : ""}`,
    ));

    await new Promise<void>((resolve, reject) => {
      let initId = "";
      const timeout = setTimeout(() => {
        if (initId) this.pendingResponses.delete(initId);
        reject(new Error("Claude Agent SDK worker 初始化超时"));
      }, CLAUDE_WORKER_INIT_TIMEOUT_MS);
      initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: this._sessionFilePath,
        isNewSession,
        config,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type !== "ready") {
          reject(new Error(optionalString(data.error) || "Claude Agent SDK worker 初始化失败"));
          return;
        }
        this._sessionFilePath = optionalString(data.sessionFilePath) || this._sessionFilePath;
        this.models = normalizeModels(data.models);
        this.isReady = true;
        this.emitEvent({ type: "session_file_path", sessionFilePath: this._sessionFilePath });
        this.emitEvent({ type: "agent_ready", agentId: "claude", mock: false });
        resolve();
      });
    });
  }

  isIdle() {
    return !this.turnActive && !this.activePromptId && this.pendingUIRequestIds.size === 0;
  }

  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions) {
    if (!this.process || !this.isReady) throw new Error("Claude Agent SDK worker is not running");
    if (!this.isIdle()) throw new Error("SESSION_BUSY");
    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptId = promptId;
    this.turnActive = true;
    this.streamedText = false;
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.emitEvent({ type: "stream_start", role: "assistant" });
    this.sendWorkerCommand({
      type: "prompt",
      id: promptId,
      message,
      images,
      permissionMode: options?.permissionMode || (options?.planModeEnabled ? "plan" : "full-access"),
      action: options?.action,
    });
  }

  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    const sourceSessionId = target.sourceSessionFilePath || this._sessionFilePath;
    if (!sourceSessionId) return { supported: true, success: false, reason: "missing Claude source session ID" };
    if (!target.targetTurnId) return { supported: true, success: false, reason: "missing native Claude message ID" };
    return {
      supported: true,
      success: true,
      sessionFilePath: createForkDescriptor(sourceSessionId, target.targetTurnId, target.newSessionId),
      nativeEntryId: target.targetTurnId,
    };
  }

  async abort() {
    this.pendingUIRequestIds.clear();
    if (this.process) {
      const data = await this.request({ type: "abort" }, 10_000);
      if (data.type !== "aborted") throw new Error(optionalString(data.error) || "Claude Code 中断失败");
    }
    this.activePromptId = null;
    this.finishTurn(true);
    this.emitEvent({ type: "aborted" });
  }

  async getModels() {
    if (this.models.length > 0) return this.models;
    const config = asRecord(await this.context?.getConfigState?.());
    const providers = Array.isArray(config.providers) ? config.providers : [];
    this.models = providers.flatMap((provider) => {
      const rawProvider = asRecord(provider);
      const providerId = optionalString(rawProvider.providerId);
      if (!providerId || !Array.isArray(rawProvider.models)) return [];
      return normalizeModels(rawProvider.models.map((model) => ({ ...asRecord(model), provider: providerId })));
    });
    return this.models;
  }

  async listActions(options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]> {
    if (!this.process || !this.isReady) return [];
    const data = await this.request({ type: "listActions", reload: options?.reload === true }, 30000);
    return Array.isArray(data.actions) ? data.actions as AgentActionCatalogEntry[] : [];
  }

  async setModel(provider: string, modelId: string) {
    const config = await this.context?.getConfigState?.();
    const data = await this.request({ type: "setModel", provider, modelId, config }, 12000);
    if (data.type !== "model_changed") throw new Error(optionalString(data.error) || "Claude Code 切换模型失败");
    this.emitEvent({ type: "model_changed", model: data.model });
  }

  async setThinkingLevel(level: string) {
    if (!CLAUDE_THINKING_LEVELS.includes(level)) throw new Error("UNSUPPORTED_THINKING_LEVEL");
    const data = await this.request({ type: "setThinkingLevel", level }, 12000);
    if (data.type !== "thinking_level_changed") {
      throw new Error(optionalString(data.error) || "Claude Code 切换思考等级失败");
    }
    this.emitEvent({ type: "thinking_level_changed", level });
  }

  sendUIResponse(response: AgentUIResponse) {
    const id = optionalString(response.id);
    if (id) this.pendingUIRequestIds.delete(id);
    this.sendWorkerCommand({ type: "uiResponse", response });
  }

  async dispose() {
    this.isReady = false;
    this.models = [];
    this.pendingResponses.clear();
    this.pendingUIRequestIds.clear();
    this.activePromptId = null;
    this.turnActive = false;
    this.eventBuffer.clear();
    const child = this.process;
    this.process = null;
    if (!child) {
      this.secretValues = [];
      return;
    }
    child.stdin?.write(`${JSON.stringify({ type: "dispose" })}\n`);
    if (!await this.waitForExit(child, 2000)) child.kill("SIGKILL");
    this.secretValues = [];
  }

  private handleWorkerMessage(value: unknown) {
    const data = asRecord(value);
    const id = data.id === undefined || data.id === null ? "" : String(data.id);
    if (id) {
      const callback = this.pendingResponses.get(id);
      if (callback) {
        this.pendingResponses.delete(id);
        callback(data);
      }
    }

    switch (data.type) {
      case "history_snapshot":
        this.emitEvent({ type: "history_snapshot", messages: data.messages });
        break;
      case "session_file_path":
        this._sessionFilePath = optionalString(data.sessionFilePath) || this._sessionFilePath;
        this.emitEvent({ type: "session_file_path", sessionFilePath: this._sessionFilePath });
        break;
      case "context_compaction":
        this.emitEvent({ type: "context_compaction", id: data.uuid || data.id });
        break;
      case "text_delta": {
        const delta = optionalString(data.delta) || "";
        if (delta) this.streamedText = true;
        this.emitEventThrottled({ type: "stream_delta", delta });
        break;
      }
      case "thinking_delta":
        this.emitEventThrottled({ type: "thinking_delta", delta: optionalString(data.delta) || "" });
        break;
      case "thinking_end":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "message_end":
        if (!this.streamedText && optionalString(data.text)) {
          this.emitEvent({ type: "stream_delta", delta: data.text });
          this.streamedText = true;
        }
        this.emitEvent({ type: "turn_metadata", nativeTurnId: data.nativeTurnId, clientUserMessageId: this.activePromptId });
        break;
      case "tool_execution_start":
        this.emitEvent(normalizeToolEvent("tool_start", {
          ...data, toolCallId: data.toolUseId, name: data.toolName, args: data.input,
        }));
        break;
      case "tool_execution_update":
        this.emitEvent(normalizeToolEvent("tool_start", {
          ...data,
          toolCallId: data.toolUseId,
          name: data.toolName,
          args: data.input,
          detail: unwrapToolText(data.output),
          result: data.output,
        }));
        break;
      case "tool_execution_end": {
        const event = normalizeToolEvent("tool_end", {
          ...data,
          toolCallId: data.toolUseId,
          name: data.toolName,
          args: data.input,
          result: data.output,
          output: data.output,
        });
        this.emitEvent(event);
        const diffs = buildDiffsFromToolEvent(event);
        if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        break;
      }
      case "ui_request": {
        const requestId = optionalString(data.requestId);
        if (!requestId) break;
        this.pendingUIRequestIds.add(requestId);
        this.emitEvent(normalizeQuestionProcessEvent({
          type: "extension_ui_request",
          id: requestId,
          requestId,
          method: data.method,
          title: data.title,
          detail: data,
          questions: data.questions,
          toolName: data.toolName,
          state: "running",
        }));
        break;
      }
      case "prompt_done":
        if (!id || id === this.activePromptId) this.activePromptId = null;
        this.finishTurn(true);
        break;
      case "error":
        if (!this.turnActive || (id && id !== this.activePromptId)) break;
        this.emitEvent({
          type: "process_event", entryType: "error", kind: "error", title: "Claude Code 运行失败",
          detail: optionalString(data.error) || "Unknown error", state: "error",
        });
        if (!id || id === this.activePromptId) this.activePromptId = null;
        this.finishTurn(true);
        break;
    }
  }

  private finishTurn(force = false) {
    if (!this.turnActive) return;
    this.eventBuffer.flush();
    this.emitEvent({ type: "stream_end", content: "", force });
    this.emitEvent({ type: "agent_end" });
    this.turnActive = false;
    this.streamedText = false;
  }

  private request(command: WorkerCommand, timeoutMs: number) {
    return new Promise<UnknownRecord>((resolve, reject) => {
      let id = "";
      const timeout = setTimeout(() => {
        if (id) this.pendingResponses.delete(id);
        reject(new Error(`Claude SDK ${command.type} timed out`));
      }, timeoutMs);
      id = this.sendWorkerCommand(command, (data) => {
        clearTimeout(timeout);
        if (data.type === "error") reject(new Error(optionalString(data.error) || `${command.type} failed`));
        else resolve(data);
      });
    });
  }

  private sendWorkerCommand(command: WorkerCommand, callback?: (data: UnknownRecord) => void) {
    const id = command.id || this.createCommandId();
    const child = this.process;
    if (!child?.stdin?.writable) throw new Error("Claude Agent SDK worker is not writable");
    if (callback) this.pendingResponses.set(id, callback);
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return id;
  }

  private createCommandId() {
    return `claude-sdk-${++this.requestId}`;
  }

  private emitEvent(event: UnknownRecord) {
    this.eventBuffer.send(event);
  }

  private emitEventThrottled(event: UnknownRecord) {
    this.eventBuffer.send(event);
  }

  private waitForExit(child: ChildProcess, timeoutMs: number) {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve(result);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
    });
  }

  private handleWorkerTermination(child: ChildProcess, detail: string) {
    if (this.process !== child) return;
    this.process = null;
    this.isReady = false;
    const redactedDetail = this.redact(detail);
    for (const callback of this.pendingResponses.values()) callback({ type: "error", error: redactedDetail });
    this.pendingResponses.clear();
    if (this.turnActive) {
      this.emitEvent({ type: "process_event", entryType: "error", kind: "error", title: "Claude Code 已断开", detail: redactedDetail, state: "error" });
      this.activePromptId = null;
      this.finishTurn(true);
    }
  }

  private redact(value: unknown) {
    let text = String(value || "");
    for (const secret of this.secretValues) {
      if (secret) text = text.split(secret).join("[REDACTED]");
    }
    return text;
  }
}
