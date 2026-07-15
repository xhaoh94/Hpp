import { execFile, spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import {
  findCommandOnPath,
  getCommandEnv,
  getNodeExecutable,
  getNpmPackageBinTarget,
  isWindowsShellShim,
} from "../../utils/command-utils";
import {
  buildDiffsFromToolEvent,
  isContextCompactionLike,
  normalizeQuestionProcessEvent,
  normalizeToolEvent,
} from "../../plugin-runtime/process-events";
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
  clientMessageId?: string;
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
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

interface DroidUserMessageParams {
  text: string;
  images?: Array<{ type: "base64"; mediaType: string; data: string }>;
}

interface PendingRpcResponse {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingDroidAskUserRequest {
  requestId: string;
  questions: Array<{ index: number; question: string }>;
}

interface RunningDroidTool {
  toolName: string;
  args?: unknown;
}

const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

function getDroidExecutable(args: string[]): { command: string; args: string[]; shell?: boolean } {
  if (process.env.DROID_PATH && existsSync(process.env.DROID_PATH)) {
    if (isWindowsShellShim(process.env.DROID_PATH)) {
      return { command: process.env.DROID_PATH, args, shell: true };
    }
    return { command: process.env.DROID_PATH, args };
  }

  const executable = findCommandOnPath("droid");
  if (!executable) return { command: "droid", args };
  if (!isWindowsShellShim(executable)) return { command: executable, args };

  const shimTarget = getNpmPackageBinTarget(executable, "droid", join("bin", "droid"));
  if (shimTarget) return { command: getNodeExecutable(["DROID_NODE_PATH", "PI_NODE_PATH"]), args: [shimTarget, ...args] };
  return { command: executable, args, shell: true };
}

function getForkTitle(content?: string) {
  const title = String(content || "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : "Hpp fork";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getDroidTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function getDroidMessageText(message: UnknownRecord): string {
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((rawBlock) => {
    const block = asRecord(rawBlock);
    if (block.type === "text" && typeof block.text === "string") return [block.text];
    return [];
  }).join("\n");
}

function getDroidHistoryMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawMessage, index) => {
    const message = asRecord(rawMessage);
    const role = message.role;
    if (role !== "user" && role !== "assistant" && role !== "system") return [];
    const content = getDroidMessageText(message).trim();
    if (!content) return [];
    const nativeTurnId = typeof message.id === "string" ? message.id : undefined;
    return [{
      id: `droid-history-${nativeTurnId || index}-${index}`,
      role,
      content,
      timestamp: getDroidTimestamp(message.createdAt || message.timestamp || message.updatedAt),
      nativeTurnId,
    }];
  });
}

function modelSupportsReasoning(model: UnknownRecord) {
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((value) => String(value).toLowerCase())
    : [];
  return efforts.some((effort) => !["off", "none"].includes(effort));
}

function getUIResponseValue(response: AgentUIResponse) {
  const answers = Array.isArray(response.answers) ? response.answers : [];
  const firstAnswer = asRecord(answers[0]);
  return String(
    firstAnswer.value ||
    firstAnswer.answer ||
    firstAnswer.label ||
    response.value ||
    response.text ||
    ""
  ).trim();
}

function getAskAnswerText(value: unknown) {
  const answer = asRecord(value);
  if (typeof answer.answer === "string") return answer.answer;
  if (typeof answer.value === "string") return answer.value;
  if (typeof answer.label === "string") return answer.label;
  if (Array.isArray(answer.selected)) return answer.selected.map(String).join(", ");
  if (Array.isArray(answer.values)) return answer.values.map(String).join(", ");
  return "";
}

// ============================================================
// Droid Agent - JSON-RPC over stdin/stdout
// ============================================================
export class DroidAgent {
  private process: ChildProcess | null = null;
  private projectPath = "";
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private nativeModelIds = new Map<string, string>();
  private rpcId = 0;
  private protocolVersion = "1.87.0";
  private pendingResponses = new Map<string, PendingRpcResponse>();
  private clientMessageIdsByRequestId = new Map<string, string>();
  private activeClientMessageId: string | null = null;
  private pendingAskUserRequest: PendingDroidAskUserRequest | null = null;
  private pendingPermissionRequestId: string | null = null;
  private isReady = false;
  private autonomyLevel: "low" | "medium" | "high" = "high";
  private interactionMode = "auto";
  private planModeEnabled = false;
  private turnActive = false;
  private isAborting = false;
  private runningToolUses = new Map<string, RunningDroidTool>();
  private completedToolUses = new Set<string>();
  private eventBuffer: AgentEventBuffer;

  constructor(hppSessionId = "default", emit?: (event: UnknownRecord) => void) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  /** Start droid exec in stream-jsonrpc mode */
  async init(projectPath: string, existingSessionId?: string): Promise<void> {
    if (
      this.process &&
      this.isReady &&
      this.projectPath === projectPath &&
      (!existingSessionId || this.sessionId === existingSessionId)
    ) {
      return;
    }

    this.projectPath = projectPath;
    await this.killProcess();
    this.isReady = false;
    this.models = [];
    this.nativeModelIds.clear();
    this.emitEvent({ type: "agent_init", agentId: "droid" });

    const args = [
      "exec",
      "--input-format", "stream-jsonrpc",
      "--output-format", "stream-jsonrpc",
      "--auto", this.autonomyLevel,
      "--cwd", projectPath,
    ];

    const executable = getDroidExecutable(args);
    this.process = spawn(executable.command, executable.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: executable.shell || false,
      env: getCommandEnv(),
    } satisfies SpawnOptions);

    const decoder = new StringDecoder("utf8");
    let buffer = "";

    const childProcess = this.process;
    childProcess.on("error", (error) => {
      if (this.process !== childProcess) return;
      this.process = null;
      const wasReady = this.isReady;
      this.isReady = false;
      this.turnActive = false;
      this.clientMessageIdsByRequestId.clear();
      this.activeClientMessageId = null;
      this.pendingAskUserRequest = null;
      this.pendingPermissionRequestId = null;
      this.failPendingResponses(error);
      if (wasReady) this.emitEvent({ type: "agent_disconnected", detail: error.message });
    });

    childProcess.on("exit", (code, signal) => {
      if (this.process !== childProcess) return;
      this.process = null;
      const wasReady = this.isReady;
      const detail = `Droid exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
      this.isReady = false;
      this.turnActive = false;
      this.clientMessageIdsByRequestId.clear();
      this.activeClientMessageId = null;
      this.pendingAskUserRequest = null;
      this.pendingPermissionRequestId = null;
      this.failPendingResponses(new Error(detail));
      if (wasReady) this.emitEvent({ type: "agent_disconnected", detail });
    });

    const processBufferedLines = () => {
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          console.warn("[droid] Ignored non-JSON stdout line:", line.slice(0, 500));
        }
      }
    };

    childProcess.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      processBufferedLines();
    });
    childProcess.stdout?.on("end", () => {
      buffer += decoder.end();
      if (buffer.trim()) buffer += "\n";
      processBufferedLines();
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      console.log("[droid]", chunk.toString().trim());
    });

    try {
      const response = existingSessionId
        ? await this.sendRpcAsync("droid.load_session", {
            sessionId: existingSessionId,
            loadAllMessages: true,
          }, 30000)
        : await this.sendRpcAsync("droid.initialize_session", {
            machineId: "default",
            cwd: projectPath,
            autonomyLevel: this.autonomyLevel,
            interactionMode: this.interactionMode,
          }, 30000);
      const result = asRecord(asRecord(response).result);
      const sessionId = existingSessionId || (typeof result.sessionId === "string" ? result.sessionId : "");
      if (!sessionId) throw new Error("Droid did not return a session id");
      this.sessionId = sessionId;
      this.isReady = true;
      await this.applySessionResult(result, !!existingSessionId);
      this.emitEvent({ type: "agent_ready", agentId: "droid", mock: false });
    } catch (error) {
      await this.killProcess();
      throw new Error(`Failed to initialize Droid: ${getErrorMessage(error)}`);
    }
  }

  /** Send a user message */
  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.process || !this.isReady) {
      throw new Error("Droid is not ready");
    }

    this.turnActive = true;
    this.isAborting = false;
    this.runningToolUses.clear();
    this.completedToolUses.clear();
    this.emitEvent({ type: "stream_start", role: "assistant" });
    try {
      const planModeEnabled = !!options?.planModeEnabled || options?.permissionMode === "plan";
      await this.setPermissionMode(planModeEnabled ? "plan" : "full-access");

      const msgParams: DroidUserMessageParams = { text: message };
      if (images && images.length > 0) {
        msgParams.images = images.map((img) => ({
          type: "base64",
          mediaType: img.mimeType,
          data: img.data,
        }));
      }

      const requestId = this.nextRpcId();
      this.activeClientMessageId = options?.clientMessageId?.trim() || null;
      if (this.activeClientMessageId) {
        this.clientMessageIdsByRequestId.set(requestId, this.activeClientMessageId);
      }
      await this.sendRpcAsync("droid.add_user_message", msgParams, 30000, requestId);
    } catch (error) {
      if (this.process) this.failActiveTurn("Droid request failed", getErrorMessage(error));
      throw error;
    }
  }

  isIdle(): boolean {
    return (
      !this.isAborting &&
      !this.turnActive &&
      this.pendingResponses.size === 0 &&
      !this.pendingAskUserRequest &&
      !this.pendingPermissionRequestId
    );
  }

  /** Abort current response */
  async abort() {
    this.isAborting = true;
    if (this.pendingPermissionRequestId) {
      this.sendRpcResponse(this.pendingPermissionRequestId, { selectedOption: "cancel" });
      this.pendingPermissionRequestId = null;
    }
    if (this.pendingAskUserRequest) {
      this.sendRpcResponse(this.pendingAskUserRequest.requestId, { cancelled: true, answers: [] });
      this.pendingAskUserRequest = null;
    }
    let detail = "";
    if (this.process) {
      try {
        await this.sendRpcAsync("droid.interrupt_session", {});
      } catch (error) {
        detail = getErrorMessage(error);
      }
    }
    this.turnActive = false;
    this.clientMessageIdsByRequestId.clear();
    this.activeClientMessageId = null;
    this.runningToolUses.clear();
    this.completedToolUses.clear();
    this.isAborting = false;
    this.emitEvent({ type: "aborted", detail: detail || undefined });
  }

  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    const sourceSessionId = target.sourceSessionFilePath || this.sessionId;
    if (!this.process || !this.isReady || !sourceSessionId) {
      return {
        supported: true,
        success: false,
        reason: "Droid source session is unavailable",
      };
    }

    if (!target.targetTurnId && (target.rollbackUserMessageCount || 0) > 0) {
      return {
        supported: true,
        success: false,
        reason: "Droid native message id is unavailable for this historical turn",
      };
    }

    try {
      const response = target.targetTurnId
        ? await this.sendRpcAsync("droid.execute_rewind", {
            sessionId: sourceSessionId,
            messageId: target.targetTurnId,
            filesToRestore: [],
            filesToDelete: [],
            forkTitle: getForkTitle(target.sourceMessageContent),
          }, 60000)
        : await this.sendRpcAsync("droid.fork_session", {
            title: getForkTitle(target.sourceMessageContent),
          });
      const result = asRecord(asRecord(response).result);
      const forkedSessionId = typeof result.newSessionId === "string" ? result.newSessionId : "";
      if (!forkedSessionId) {
        return {
          supported: true,
          success: false,
          reason: "Droid did not return a forked session id",
        };
      }

      return {
        supported: true,
        success: true,
        sessionFilePath: forkedSessionId,
        nativeEntryId: target.targetTurnId,
      };
    } catch (error) {
      return {
        supported: true,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Get models returned by the active Droid session. */
  async getModels(): Promise<AgentModel[]> {
    return this.models;
  }

  /** Set model - sends setting update via RPC */
  async setModel(provider: string, modelId: string) {
    if (!this.process || !this.isReady) throw new Error("Droid is not ready");
    const nativeModelId = this.nativeModelIds.get(`${provider}:${modelId}`) || modelId;
    await this.sendRpcAsync("droid.update_session_settings", { modelId: nativeModelId });
    this.emitEvent({ type: "model_changed", model: { id: modelId, provider } });
  }

  /** Set reasoning effort */
  async setThinkingLevel(level: string) {
    const effortMap: Record<string, string> = {
      off: "off", none: "none", low: "low", medium: "medium", high: "high",
    };
    if (!this.process || !this.isReady) throw new Error("Droid is not ready");
    await this.sendRpcAsync("droid.update_session_settings", { reasoningEffort: effortMap[level] || level });
    this.emitEvent({ type: "thinking_level_changed", level });
  }

  private async setPermissionMode(mode: "plan" | "full-access") {
    const nextPlanModeEnabled = mode === "plan";
    const nextInteractionMode = nextPlanModeEnabled ? "spec" : "auto";
    const nextAutonomyLevel: "low" | "medium" | "high" = nextPlanModeEnabled ? "medium" : "high";
    const settings: Record<string, unknown> = {};

    if (this.interactionMode !== nextInteractionMode) {
      settings.interactionMode = nextInteractionMode;
    }
    if (this.autonomyLevel !== nextAutonomyLevel) {
      settings.autonomyLevel = nextAutonomyLevel;
    }
    if (this.process && this.isReady && Object.keys(settings).length > 0) {
      await this.sendRpcAsync("droid.update_session_settings", settings);
    }
    this.planModeEnabled = nextPlanModeEnabled;
    this.interactionMode = nextInteractionMode;
    this.autonomyLevel = nextAutonomyLevel;
    this.emitEvent({
      type: "process_event",
      entryType: "status",
      title: nextPlanModeEnabled ? "Droid 已进入 Spec 模式" : "Droid 已开启完全访问模式",
      state: "completed",
    });
  }

  sendUIResponse(response: AgentUIResponse) {
    if (!this.process || !this.isReady) return;
    const responseRequestId = typeof response.id === "string"
      ? response.id
      : typeof response.requestId === "string"
        ? response.requestId
        : "";
    if (this.pendingPermissionRequestId && (!responseRequestId || responseRequestId === this.pendingPermissionRequestId)) {
      const selectedValue = getUIResponseValue(response).toLowerCase();
      const selectedOption = ["proceed_once", "allow", "yes", "允许"].includes(selectedValue)
        ? "proceed_once"
        : ["proceed_always", "always", "始终允许"].includes(selectedValue)
          ? "proceed_always"
          : "cancel";
      this.sendRpcResponse(this.pendingPermissionRequestId, {
        selectedOption,
      });
      this.pendingPermissionRequestId = null;
      return;
    }
    if (this.pendingAskUserRequest && (!responseRequestId || responseRequestId === this.pendingAskUserRequest.requestId)) {
      const pending = this.pendingAskUserRequest;
      const result = asRecord(response.result);
      const rawAnswers = Array.isArray(response.answers)
        ? response.answers
        : Array.isArray(result.answers)
          ? result.answers
          : [];
      const fallbackText = typeof response.text === "string"
        ? response.text
        : typeof response.value === "string"
          ? response.value
          : "";
      const answers = pending.questions.map((question, index) => ({
        index: question.index,
        question: question.question,
        answer: getAskAnswerText(rawAnswers[index]) || (index === 0 ? fallbackText : ""),
      }));
      this.sendRpcResponse(pending.requestId, {
        cancelled: response.cancelled === true,
        answers: response.cancelled === true ? [] : answers,
      });
      this.pendingAskUserRequest = null;
      return;
    }
  }

  get sessionFilePath(): string | null { return this.sessionId; }

  /** Dispose and clean up */
  async dispose() {
    await this.killProcess();
  }

  private async killProcess() {
    const childProcess = this.process;
    this.process = null;
    childProcess?.stdin?.end();
    this.isReady = false;
    this.sessionId = null;
    this.failPendingResponses(new Error("Droid process stopped"));
    this.clientMessageIdsByRequestId.clear();
    this.activeClientMessageId = null;
    this.pendingAskUserRequest = null;
    this.pendingPermissionRequestId = null;
    this.turnActive = false;
    this.isAborting = false;
    this.runningToolUses.clear();
    this.completedToolUses.clear();
    this.eventBuffer.flush();
    if (!childProcess) return;
    if (await this.waitForExit(childProcess, 750)) return;
    await this.killProcessTree(childProcess);
    await this.waitForExit(childProcess, 500);
  }

  private async killProcessTree(childProcess: ChildProcess): Promise<void> {
    if (process.platform !== "win32" || !childProcess.pid) {
      childProcess.kill("SIGKILL");
      return;
    }
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
  }

  private waitForExit(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (childProcess.exitCode != null || childProcess.signalCode != null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        childProcess.off("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      childProcess.once("exit", onExit);
    });
  }

  // ---- JSON-RPC (Factory protocol) ----

  private nextRpcId() {
    return `rpc-${++this.rpcId}`;
  }

  private sendRpc(method: string, params: unknown, id = this.nextRpcId()): string {
    const childProcess = this.process;
    if (!childProcess?.stdin?.writable) throw new Error("Droid process is not writable");
    const msg = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: this.protocolVersion,
      type: "request",
      id,
      method,
      params,
    };
    childProcess.stdin.write(JSON.stringify(msg) + "\n");
    return id;
  }

  private sendRpcAsync(method: string, params: unknown, timeoutMs = 30000, requestId = this.nextRpcId()): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pendingResponses.set(requestId, { resolve, reject, timeout });
      try {
        this.sendRpc(method, params, requestId);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingResponses.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendRpcResponse(requestId: string, result: unknown) {
    const msg = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: this.protocolVersion,
      type: "response",
      id: requestId,
      result,
    };
    if (!this.process?.stdin?.writable) throw new Error("Droid process is not writable");
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleMessage(data: unknown) {
    const message = asRecord(data);
    if (typeof message.factoryProtocolVersion === "string" && message.factoryProtocolVersion) {
      this.protocolVersion = message.factoryProtocolVersion;
    }
    const msgType = message.type;

    if (msgType === "response") {
      // Response to our RPC call
      const id = typeof message.id === "string" ? message.id : "";
      const pending = id ? this.pendingResponses.get(id) : undefined;
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(id);
        const error = asRecord(message.error);
        if (message.error) pending.reject(new Error(String(error.message || "Droid request failed")));
        else pending.resolve(data);
      }
    } else if (msgType === "notification") {
      // Server-to-client notification
      const params = asRecord(message.params);
      const notification = asRecord(params.notification);
      const method = message.method || notification.type;
      this.handleNotification(String(method || ""), message.params || message);
    } else if (msgType === "request") {
      // Server-to-client request (permission, ask_user)
      const id = typeof message.id === "string" ? message.id : "";
      const method = typeof message.method === "string" ? message.method : "";
      if (id && method) this.handleServerRequest(method, id, message.params);
    }
  }

  private handleServerRequest(method: string, requestId: string, params: unknown) {
    const paramsRecord = asRecord(params);
    switch (method) {
      case "droid.request_permission":
        if (!this.planModeEnabled) {
          this.sendRpcResponse(requestId, { selectedOption: "proceed_once" });
        } else {
          this.pendingPermissionRequestId = requestId;
          this.emitEvent(normalizeQuestionProcessEvent({
            type: method,
            requestId,
            detail: params,
            title: paramsRecord.title || paramsRecord.message || "Droid 请求权限",
            options: [
              { label: "允许", value: "proceed_once" },
              { label: "拒绝", value: "cancel" },
            ],
          }));
        }
        break;
      case "droid.ask_user":
        {
          const questions = Array.isArray(paramsRecord.questions)
            ? paramsRecord.questions.map((rawQuestion, index) => {
                const question = asRecord(rawQuestion);
                return {
                  index: typeof question.index === "number" ? question.index : index,
                  question: String(question.question || `Question ${index + 1}`),
                };
              })
            : [];
          this.pendingAskUserRequest = { requestId, questions };
          this.emitEvent(normalizeQuestionProcessEvent({
            type: method,
            requestId,
            questions: paramsRecord.questions,
            detail: params,
          }));
        }
        break;
    }
  }

  private handleNotification(method: string, params: unknown) {
    const paramsRecord = asRecord(params);
    const notification = asRecord(paramsRecord.notification || paramsRecord);
    const notifType = String(notification.type || method);
    const notifData = asRecord(notification.data || notification);

    if (notifType === "session_compacted") {
      this.emitEvent({ type: "context_compaction", id: notifData.summaryId || notification.id || paramsRecord.id });
      return;
    }

    if (
      isContextCompactionLike(
        method,
        notifType,
        notifData.type,
        notifData.name,
        notifData.title,
        notifData.message,
        notifData.status
      )
    ) {
      this.emitEvent({ type: "context_compaction", id: notifData.id || notification.id || paramsRecord.id });
      return;
    }

    switch (notifType) {
      case "create_message":
        {
          const message = asRecord(notifData.message);
          if (typeof message.id !== "string") break;
          const contentBlocks = this.getMessageContentBlocks(message);
          if (message.role === "assistant") {
            if (this.turnActive) {
              if (!contentBlocks.some((block) => block.type === "tool_use")) {
                this.completeRunningToolUses();
              }
              this.startToolUses(contentBlocks);
            }
            this.emitTurnMetadata(message.id);
            break;
          }
          if (message.role !== "user") break;
          const hasToolResults = contentBlocks.some((block) => block.type === "tool_result");
          if (hasToolResults) {
            this.finishToolUses(contentBlocks);
            break;
          }
          if (message.id.startsWith("context-")) break;
          const requestId = typeof notifData.requestId === "string" ? notifData.requestId : "";
          let clientMessageId = requestId ? this.clientMessageIdsByRequestId.get(requestId) : undefined;
          if (!clientMessageId && this.clientMessageIdsByRequestId.size === 1) {
            clientMessageId = this.clientMessageIdsByRequestId.values().next().value;
          }
          clientMessageId ||= this.activeClientMessageId || undefined;
          if (!clientMessageId) break;
          this.activeClientMessageId = clientMessageId;
          if (requestId) {
            this.clientMessageIdsByRequestId.delete(requestId);
          } else {
            for (const [pendingRequestId, pendingClientMessageId] of this.clientMessageIdsByRequestId) {
              if (pendingClientMessageId === clientMessageId) {
                this.clientMessageIdsByRequestId.delete(pendingRequestId);
                break;
              }
            }
          }
          this.emitTurnMetadata(message.id, clientMessageId);
        }
        break;
      case "assistant_text_delta":
        if (!this.turnActive) break;
        this.emitEvent({ type: "stream_delta", delta: String(notifData.textDelta || notifData.delta || notifData.text || "") });
        break;
      case "assistant_text_complete":
        if (!this.turnActive) break;
        this.emitTurnMetadata(notifData.messageId);
        break;
      case "thinking_text_delta":
        if (!this.turnActive) break;
        this.emitEvent({ type: "thinking_delta", delta: String(notifData.textDelta || notifData.delta || notifData.text || "") });
        break;
      case "thinking_text_complete":
        if (!this.turnActive) break;
        this.emitEvent({ type: "thinking_end" });
        break;
      case "tool_progress_update":
        {
          if (!this.turnActive) break;
          const update = asRecord(notifData.update);
          const status = String(update.status || "").toLowerCase();
          const isError = update.type === "error" || !!update.error || status === "error" || status === "failed";
          const toolCallId = String(notifData.toolUseId || notifData.toolCallId || notifData.id || notifData.toolName || "");
          const normalizedInput = {
            toolName: notifData.toolName || update.toolName || "tool",
            toolCallId: toolCallId || undefined,
            args: update.parameters || notifData.args || notifData.input,
            result: update.fullOutput || update.text || update.valueSnippet || notifData.result,
            detail: update.details || update.text || update.status || notifData.message || notifData.status,
            patch: update.patch || notifData.patch || notifData.diff,
            isError,
          };
          const phase = update.type === "tool_result" || isError || ["completed", "complete", "done", "success"].includes(status)
            ? "tool_end"
            : "tool_start";
          if (toolCallId && phase === "tool_end" && this.completedToolUses.has(toolCallId)) break;
          if (toolCallId && phase === "tool_start") {
            this.runningToolUses.set(toolCallId, {
              toolName: String(normalizedInput.toolName),
              args: normalizedInput.args,
            });
          }
          const toolEvent = normalizeToolEvent(phase, normalizedInput);
          this.emitEvent(toolEvent);
          if (phase === "tool_end") {
            if (toolCallId) {
              this.runningToolUses.delete(toolCallId);
              this.completedToolUses.add(toolCallId);
            }
            const diffs = buildDiffsFromToolEvent(toolEvent);
            if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
          }
        }
        break;
      case "droid_working_state_changed":
        {
          const state = String(notifData.newState || notifData.state || notifData.status || "").toLowerCase();
          const isIdle = notifData.working === false || state === "idle";
          if (state && state !== "executing_tool") this.completeRunningToolUses();
          if (isIdle) {
            const shouldFinishTurn = this.turnActive;
            this.turnActive = false;
            if (shouldFinishTurn) {
              this.emitEvent({ type: "stream_end" });
              this.emitEvent({ type: "agent_end" });
            }
            this.activeClientMessageId = null;
            this.clientMessageIdsByRequestId.clear();
          } else if (notifData.working === true || state) {
            this.turnActive = true;
          }
        }
        break;
      case "error":
        this.turnActive = false;
        this.activeClientMessageId = null;
        this.clientMessageIdsByRequestId.clear();
        this.pendingAskUserRequest = null;
        this.pendingPermissionRequestId = null;
        this.runningToolUses.clear();
        this.completedToolUses.clear();
        this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${notifData.message || "未知错误"}` });
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        break;
    }
  }

  private getMessageContentBlocks(message: UnknownRecord) {
    return Array.isArray(message.content) ? message.content.map(asRecord) : [];
  }

  private startToolUses(contentBlocks: UnknownRecord[]) {
    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      const toolCallId = String(block.id || block.tool_use_id || block.toolUseId || "");
      if (!toolCallId || this.runningToolUses.has(toolCallId) || this.completedToolUses.has(toolCallId)) continue;
      const toolName = String(block.name || block.toolName || "tool");
      const args = block.input || block.args || block.parameters;
      this.runningToolUses.set(toolCallId, { toolName, args });
      this.emitEvent(normalizeToolEvent("tool_start", {
        toolName,
        toolCallId,
        args,
      }));
    }
  }

  private finishToolUses(contentBlocks: UnknownRecord[]) {
    for (const block of contentBlocks) {
      if (block.type !== "tool_result") continue;
      const toolCallId = String(block.tool_use_id || block.toolUseId || block.id || "");
      this.finishToolUse(toolCallId, block.content, block.is_error === true);
    }
  }

  private completeRunningToolUses() {
    for (const toolCallId of [...this.runningToolUses.keys()]) {
      this.finishToolUse(toolCallId);
    }
  }

  private finishToolUse(toolCallId: string, result?: unknown, isError = false) {
    if (!toolCallId || this.completedToolUses.has(toolCallId)) return;
    const runningTool = this.runningToolUses.get(toolCallId);
    const toolEvent = normalizeToolEvent("tool_end", {
      toolName: runningTool?.toolName || "tool",
      toolCallId,
      args: runningTool?.args,
      result,
      isError,
    });
    this.emitEvent(toolEvent);
    const diffs = buildDiffsFromToolEvent(toolEvent);
    if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
    this.runningToolUses.delete(toolCallId);
    this.completedToolUses.add(toolCallId);
  }

  private async applySessionResult(result: UnknownRecord, restoreHistory: boolean) {
    const customModels = await this.readCustomModelConfig();
    const customByNativeId = new Map<string, UnknownRecord>();
    for (const model of customModels) {
      const nativeId = typeof model.id === "string" ? model.id : "";
      if (nativeId) customByNativeId.set(nativeId, model);
    }

    this.models = [];
    this.nativeModelIds.clear();
    const availableModels = Array.isArray(result.availableModels) ? result.availableModels : [];
    const seenModels = new Set<string>();
    for (const rawModel of availableModels) {
      const model = asRecord(rawModel);
      const nativeModelId = String(model.id || model.modelId || "").trim();
      if (!nativeModelId) continue;
      const customModel = customByNativeId.get(nativeModelId);
      const modelId = customModel
        ? String(customModel.model || nativeModelId).trim()
        : nativeModelId;
      const provider = customModel
        ? String(customModel.hppProviderId || customModel.provider || "factory-custom")
        : String(model.modelProvider || "factory");
      const key = `${provider}:${modelId}`;
      if (seenModels.has(key)) continue;
      seenModels.add(key);
      this.nativeModelIds.set(key, nativeModelId);
      this.models.push({
        id: modelId,
        name: String(model.displayName || model.shortDisplayName || customModel?.displayName || modelId),
        provider,
        reasoning: modelSupportsReasoning(model),
        supportsImages: model.noImageSupport !== true,
      });
    }

    if (restoreHistory) {
      const messages = getDroidHistoryMessages(asRecord(result.session).messages);
      if (messages.length > 0) this.emitEvent({ type: "history_snapshot", messages });
    }
  }

  private async readCustomModelConfig(): Promise<UnknownRecord[]> {
    try {
      const configPath = process.env.DROID_CONFIG_PATH || join(homedir(), ".factory", "settings.json");
      const config = asRecord(JSON.parse(await readFile(configPath, "utf-8")));
      return Array.isArray(config.customModels)
        ? config.customModels.map(asRecord).filter((model) => Object.keys(model).length > 0)
        : [];
    } catch {
      return [];
    }
  }

  private failPendingResponses(error: Error) {
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingResponses.clear();
  }

  private failActiveTurn(title: string, detail: string) {
    const shouldFinish = this.turnActive;
    this.turnActive = false;
    this.clientMessageIdsByRequestId.clear();
    this.activeClientMessageId = null;
    this.pendingAskUserRequest = null;
    this.pendingPermissionRequestId = null;
    this.isAborting = false;
    this.runningToolUses.clear();
    this.completedToolUses.clear();
    this.emitEvent({
      type: "process_event",
      entryType: "error",
      title,
      detail,
      state: "error",
    });
    if (shouldFinish) {
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
    }
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  private emitTurnMetadata(nativeTurnId: unknown, clientMessageId = this.activeClientMessageId) {
    if (typeof nativeTurnId !== "string" || !nativeTurnId || !clientMessageId) return;
    this.emitEvent({
      type: "turn_metadata",
      nativeTurnId,
      clientUserMessageId: clientMessageId,
    });
  }
}
