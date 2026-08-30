import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { join } from "path";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import { buildDiffsFromToolEvent, isContextCompactionLike, normalizeQuestionProcessEvent, normalizeToolEvent, unwrapToolText, withoutToolDiffPayload } from "../../plugin-runtime/process-events";
import { getPluginWorkerInvocation } from "../../plugin-runtime/plugin-worker-runtime";
import {
  formatSubagentModel,
  humanizeSubagentLabel,
  isNativeSubagentToolName,
  isTerminalNativeSubagentStatus,
  normalizeNativeSubagentStatus,
  normalizeNativeSubagentStopReason,
  type NativeSubagentStatus,
  type NativeSubagentStopReason,
} from "../../plugin-runtime/subagent-events";
import type { AgentImagePayload, AgentUIResponse, UnknownRecord } from "../../../src/types/ipc";
import { isRecord } from "../../../src/types/ipc";
import {
  normalizeAgentCompactionConfig,
  type AgentCompactionConfig,
} from "../../../shared/agent-compaction";
import type {
  AgentActionCatalogEntry,
  AgentActionInvocation,
  AgentActionListOptions,
} from "../../../shared/agent-actions";
import type { AgentSubagentConfig } from "../../../shared/agent-subagent";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
  /** 思考档位呈现模式：levels=有档位声明（下拉）；toggle=仅有思考开关（无档位声明，如 mimo）。 */
  thinkingLevelMode?: "levels" | "toggle";
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  permissionMode?: import("../../../shared/agent-permissions").AgentPermissionMode;
  displayMessage?: string;
  hostSystemPrompt?: string;
  clientMessageId?: string;
  action?: AgentActionInvocation;
}

interface AgentInitOptions {
  hostSystemPrompt?: string;
  compaction?: AgentCompactionConfig;
  subagent?: AgentSubagentConfig;
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
      supportedThinkingLevels: Array.isArray(model.supportedThinkingLevels)
        ? model.supportedThinkingLevels.filter((level): level is string => typeof level === "string")
        : undefined,
      thinkingLevelMode: model.thinkingLevelMode === "levels" || model.thinkingLevelMode === "toggle"
        ? model.thinkingLevelMode
        : undefined,
    }];
  });
};

const PI_WORKER_INIT_TIMEOUT_MS = 120_000;
// A context compaction keeps the worker busy for potentially tens of
// seconds. Probing for models mid-compaction can time out and report an
// empty list, which the renderer would treat as "no models available" and
// clear its model picker. Wait (bounded) for the compaction to settle before
// asking the worker for the model list.
const PI_COMPACTION_MODEL_WAIT_MS = 30_000;
const PI_SUBAGENT_DETAIL_CAP = 4000;

type PiSubagentStart = {
  startedAt: number;
  args: UnknownRecord;
  action?: "spawnAgent" | "resumeAgent";
};

const truncatePiSubagentText = (value: unknown, maxLength = PI_SUBAGENT_DETAIL_CAP) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
};

const getPiSubagentDetails = (value: unknown): UnknownRecord => {
  const payload = asRecord(value);
  if (isRecord(payload.details)) return payload.details;
  return Array.isArray(payload.results) ? payload : {};
};

const getPiSubagentTaskItems = (
  args: UnknownRecord,
  fallbackStatus: NativeSubagentStatus = "pending",
) => {
  const collection = Array.isArray(args.chain)
    ? args.chain
    : Array.isArray(args.tasks)
      ? args.tasks
      : [args];
  return collection.flatMap((value, index) => {
    const item = asRecord(value);
    const agent = String(item.agent || item.name || "subagent").trim();
    const task = String(item.task || item.prompt || item.message || "").trim();
    const prompt = truncatePiSubagentText(task);
    if (!agent && !prompt) return [];
    return [{
      id: `task-${index + 1}`,
      label: humanizeSubagentLabel(agent || `subagent-${index + 1}`),
      status: fallbackStatus,
      model: typeof item.model === "string" ? item.model : undefined,
      message: undefined,
      prompt,
    }];
  });
};

const getPiSubagentUsage = (result: UnknownRecord) => {
  const usage = asRecord(result.usage);
  const numberValue = (...values: unknown[]) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return undefined;
  };
  const costRecord = asRecord(usage.cost);
  const parsed = {
    inputTokens: numberValue(usage.inputTokens, usage.input, usage.promptTokens),
    outputTokens: numberValue(usage.outputTokens, usage.output, usage.completionTokens),
    cacheReadTokens: numberValue(usage.cacheReadTokens, usage.cacheRead, usage.cache_read),
    cacheWriteTokens: numberValue(usage.cacheWriteTokens, usage.cacheWrite, usage.cache_write),
    totalTokens: numberValue(usage.totalTokens, usage.total_tokens),
    cost: numberValue(usage.cost, costRecord.total, costRecord.totalUsd, costRecord.usd),
    turns: numberValue(usage.turns),
  };
  const compact = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
};

const getPiSubagentResultText = (result: UnknownRecord) => {
  // 子 Agent 可能已经完成过一轮工具调用并有旧 output，但当前仍在运行。
  // 运行中优先展示最近活动，否则摘要会一直停留在上一轮结果。
  if (result.exitCode === -1) {
    const activity = truncatePiSubagentText(result.message);
    if (activity) return activity;
  }
  const direct = [result.output, result.message, result.summary, result.detail, result.errorMessage, result.stderr]
    .map((value) => truncatePiSubagentText(value))
    .find(Boolean);
  if (direct) return direct;
  if (Array.isArray(result.messages)) {
    for (let index = result.messages.length - 1; index >= 0; index -= 1) {
      const message = asRecord(result.messages[index]);
      if (message.role !== "assistant") continue;
      const content = Array.isArray(message.content)
        ? message.content.map((part) => {
          const item = asRecord(part);
          return typeof item.text === "string" ? item.text : typeof part === "string" ? part : "";
        }).filter(Boolean).join("")
        : typeof message.content === "string" ? message.content : "";
      const text = truncatePiSubagentText(content);
      if (text) return text;
    }
  }
  return undefined;
};

const getPiSubagentResultStatus = (result: UnknownRecord, terminal: boolean): NativeSubagentStatus => {
  if (result.exitCode === -1) return "running";
  const stopReason = normalizeNativeSubagentStopReason(result.stopReason);
  if (stopReason === "timeout") return "error";
  const explicit = normalizeNativeSubagentStatus(result.status ?? result.state ?? result.stopReason);
  if (explicit) return explicit;
  if (result.isError === true || (typeof result.exitCode === "number" && result.exitCode !== 0)) return "error";
  return terminal ? "completed" : "running";
};

const getPiSubagentOverallState = (
  results: Array<{ status: NativeSubagentStatus }>,
  record: UnknownRecord,
  terminal: boolean,
): "running" | "completed" | "error" | "interrupted" => {
  if (results.some((result) => result.status === "running" || result.status === "pending")) return "running";
  if (results.some((result) => result.status === "interrupted")) return "interrupted";
  if (results.some((result) => result.status === "error")) return "error";
  if (record.isError === true) {
    const text = `${String(record.error || "")} ${String(record.result || "")}`.toLowerCase();
    return text.includes("abort") || text.includes("cancel") || text.includes("中断") ? "interrupted" : "error";
  }
  return terminal ? "completed" : "running";
};

const buildPiSubagentEvent = (
  record: UnknownRecord,
  start: PiSubagentStart | undefined,
  terminal: boolean,
): UnknownRecord => {
  const toolCallId = String(record.toolCallId || record.callId || record.id || "pi-subagent");
  const recordArgs = asRecord(record.args);
  const startArgs = asRecord(start?.args);
  const args = Object.keys(recordArgs).length > 0 ? { ...startArgs, ...recordArgs } : startArgs;
  const resultRecord = asRecord(record.result);
  const background = record.background === true
    || args.background === true
    || args.run_in_background === true
    || args.runInBackground === true
    || resultRecord.background === true;
  const action = record.action === "resumeAgent" || record.action === "resume"
    || start?.action === "resumeAgent"
    || asRecord(record.result).action === "resumeAgent"
    ? "resumeAgent"
    : "spawnAgent";
  const payload = record.partialResult ?? record.result;
  const details = getPiSubagentDetails(payload);
  const rawResults = Array.isArray(details.results) ? details.results : [];
  const parsedResults = rawResults.map((value, index) => {
    const result = asRecord(value);
    const status = getPiSubagentResultStatus(result, terminal);
    const agent = String(result.agent || result.name || args.agent || `subagent-${index + 1}`).trim();
    const task = truncatePiSubagentText(String(result.task || "").trim());
    const usage = getPiSubagentUsage(result);
    return {
      id: `${toolCallId}:${index + 1}`,
      label: humanizeSubagentLabel(agent),
      status,
      model: formatSubagentModel(result.model),
      message: getPiSubagentResultText(result),
      prompt: task || undefined,
      ...(normalizeNativeSubagentStopReason(result.stopReason) ? { stopReason: normalizeNativeSubagentStopReason(result.stopReason) } : {}),
      ...(usage ? { usage } : {}),
    };
  });
  const subagents = parsedResults.length > 0
    ? parsedResults
    : getPiSubagentTaskItems(args, terminal ? "completed" : "pending").map((item, index) => ({
      ...item,
      id: `${toolCallId}:${index + 1}`,
    }));
  const state = getPiSubagentOverallState(subagents, record, terminal);
  const childStopReason = subagents
    .map((subagent) => "stopReason" in subagent ? subagent.stopReason : undefined)
    .find(Boolean);
  const stopReason = childStopReason
    || normalizeNativeSubagentStopReason(record.stopReason)
    || normalizeNativeSubagentStopReason(asRecord(payload).stopReason);
  const output = truncatePiSubagentText(unwrapToolText(payload));
  const prompt = getPiSubagentTaskItems(args).map((item) => item.prompt).filter(Boolean).join("\n\n") || undefined;
  const startedAt = start?.startedAt || Date.now();
  const completed = state !== "running";
  return {
    type: "subagent_event",
    id: toolCallId,
    toolCallId,
    phase: completed ? "completed" : "started",
    action,
    tool: action,
    title: stopReason === "timeout" ? "已超时" : state === "error" ? "工作失败" : state === "interrupted" ? "已中断" : completed ? "已完成" : "正在工作",
    detail: output,
    prompt,
    stopReason,
    state,
    subagents: subagents.length > 0 ? subagents : [{
      id: toolCallId,
      label: "Subagent",
      status: state === "running" ? "running" : state,
    }],
    timestamp: startedAt,
    startedAt,
    completedAt: completed ? Date.now() : undefined,
    ...(background ? { background: true } : {}),
    agentThreadId: subagents[0]?.id || toolCallId,
    receiverThreadIds: subagents.map((subagent) => subagent.id),
    source: "pi",
  };
};

export class PiSDKAgent {
  private process: ChildProcess | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventBuffer: AgentEventBuffer;
  private pendingResponses = new Map<string, (data: UnknownRecord) => void>();
  private requestId = 0;
  private models: AgentModel[] = [];
  private pendingAssistantText = "";
  private pendingAssistantError = "";
  private streamedText = false;
  private streamedTextBuffer = "";
  private streamedMessageTextBuffer = "";
  private pendingAssistantTextNeedsEmit = false;
  private pendingUIRequestIds = new Set<string>();
  private turnFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private isAborting = false;
  private activePromptIds = new Set<string>();
  private turnActive = false;
  private agentEndObserved = false;
  private compactionActive = false;
  private turnToken = 0;
  private initPromise: Promise<void> | null = null;
  private initKey: string | null = null;
  private isReady = false;
  private hostSystemPrompt = "";
  private compactionConfig = normalizeAgentCompactionConfig(undefined);
  private subagentConfig: AgentSubagentConfig | undefined;
  private guidancePendingResponse = false;
  private piSubagentStarts = new Map<string, PiSubagentStart>();
  private piSubagentTerminalStates = new Map<string, NativeSubagentStatus>();
  // Ordinary tool end notifications can be replayed by an adapter after a
  // turn is settled. Keep operation ids until the next turn so a replay cannot
  // create a second process entry or append the same Diff again.
  private activeToolCallIds = new Set<string>();
  private completedToolCallIds = new Set<string>();
  private ignoredToolCallIds = new Set<string>();

  constructor(hppSessionId = "default", emit?: (event: UnknownRecord) => void) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  get sessionFilePath(): string | null {
    return this._sessionFilePath;
  }

  async init(projectPath: string, existingSessionFilePath?: string, options?: AgentInitOptions): Promise<void> {
    const requestedSessionFilePath = existingSessionFilePath || null;
    const requestedHostSystemPrompt = String(options?.hostSystemPrompt || "").trim();
    const requestedCompactionConfig = normalizeAgentCompactionConfig(options?.compaction);
    const requestedSubagentConfig = options?.subagent;
    const nextInitKey = `${projectPath}\n${requestedSessionFilePath || ""}\n${requestedHostSystemPrompt}\n${JSON.stringify(requestedCompactionConfig)}\n${JSON.stringify(requestedSubagentConfig || null)}`;
    if (this.initPromise && this.initKey === nextInitKey) {
      return this.initPromise;
    }

    if (
      this.process &&
      this.isReady &&
      this.projectPath === projectPath &&
      this.hostSystemPrompt === requestedHostSystemPrompt &&
      JSON.stringify(this.compactionConfig) === JSON.stringify(requestedCompactionConfig) &&
      JSON.stringify(this.subagentConfig || null) === JSON.stringify(requestedSubagentConfig || null) &&
      (!requestedSessionFilePath || this._sessionFilePath === requestedSessionFilePath)
    ) {
      return;
    }

    this.initKey = nextInitKey;
    await this.dispose();
    this.initKey = nextInitKey;
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.hostSystemPrompt = requestedHostSystemPrompt;
    this.compactionConfig = requestedCompactionConfig;
    this.subagentConfig = requestedSubagentConfig;
    this.models = [];
    this.isReady = false;
    this.emitEvent({ type: "agent_init", agentId: "pi" });

    const worker = getPluginWorkerInvocation("pi-sdk-worker.mjs", ["PI_NODE_PATH"], true);
    const userRuntimeRoot = join(process.env.HPP_DATA_DIR || process.cwd(), "pi-sdk-runtime");
    // Let Pi use its own default config directory (~/.pi/agent), where its
    // CLI and SDK share auth.json/models.json. Hpp only supplies the runtime
    // package location and must not redirect credentials to a separate folder.
    const workerEnv = {
      ...worker.env,
      PI_SDK_PACKAGE_ROOT: userRuntimeRoot,
    };
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
          this.handleWorkerMessage(JSON.parse(line), child);
        } catch {
          // Ignore non-protocol output from dependencies.
        }
      }
    });
    child.stdout?.on("end", () => {
      this.handleWorkerTermination(
        child,
        "Pi SDK worker disconnected",
        "Pi SDK worker output pipe closed before the process exited.",
      );
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText = `${stderrText}${text}`.slice(-4000);
      console.log("[pi-sdk-worker]", text.trim());
    });

    child.stdin?.on("error", (error) => {
      this.handleWorkerTermination(
        child,
        "Pi SDK worker input failed",
        `Pi SDK worker input pipe closed: ${error.message}`,
      );
    });

    child.on("error", (error) => {
      this.handleWorkerTermination(
        child,
        "Pi 启动失败",
        `${error.message}\n请确认系统 PATH 中的 node 版本 >= 22.19.0，或设置 PI_NODE_PATH 指向兼容版本。`,
      );
    });

    child.on("exit", (code, signal) => {
      const exitReason = signal || (code ?? "unknown");
      const detail = getWorkerErrorDetail();
      this.handleWorkerTermination(child, "Pi SDK worker 已退出", [
        `Pi SDK worker exited before completing the request (${exitReason})`,
        detail,
      ].filter(Boolean).join("\n"));
    });

    const initPromise = new Promise<void>((resolve, reject) => {
      let initId = "";
      const timeout = setTimeout(() => {
        if (initId) this.pendingResponses.delete(initId);
        reject(new Error("Pi SDK worker init timed out"));
      }, PI_WORKER_INIT_TIMEOUT_MS);
      try {
        initId = this.sendWorkerCommand({
          type: "init",
          projectPath,
          sessionFilePath: existingSessionFilePath,
          hostSystemPrompt: this.hostSystemPrompt,
          compactionConfig: this.compactionConfig,
          subagentConfig: this.subagentConfig,
        }, (data) => {
          clearTimeout(timeout);
          if (data.type === "ready") {
            this._sessionFilePath = optionalString(data.sessionFilePath) || existingSessionFilePath || null;
            this.isReady = true;
            this.emitEvent({ type: "agent_ready", agentId: "pi", mock: false });
            resolve();
          } else {
            reject(new Error(optionalString(data.error) || "Pi SDK worker init failed"));
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    this.initPromise = initPromise;
    try {
      await initPromise;
    } catch (error) {
      if (this.process === child) {
        this.process = null;
        this.isReady = false;
        child.kill();
      }
      throw error;
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
        this.initKey = null;
      }
    }
  }

  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting || this.compactionActive || this.turnActive || this.activePromptIds.size > 0) {
      throw new Error("SESSION_BUSY");
    }
    this.prepareNewTurn();

    const promptId = options?.clientMessageId || this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.beginTurn();
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
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Pi request failed",
        detail: error instanceof Error ? error.message : String(error),
        state: "error",
      });
      this.completeTurn(true);
      throw error;
    }
  }

  async listActions(options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    return new Promise((resolve, reject) => {
      let requestId = "";
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        reject(new Error("Pi SDK list actions timed out"));
      }, 30000);
      try {
        requestId = this.sendWorkerCommand({ type: "listActions", reload: options?.reload === true }, (data) => {
          clearTimeout(timeout);
          if (data.type === "actions") {
            resolve(Array.isArray(data.actions) ? data.actions as AgentActionCatalogEntry[] : []);
            return;
          }
          reject(new Error(optionalString(data.error) || "Pi SDK list actions failed"));
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  isIdle(): boolean {
    // Model/action/config callbacks in pendingResponses are control RPCs, not
    // conversation activity. Turn and UI state are tracked explicitly below.
    return (
      !this.isAborting &&
      !this.turnActive &&
      !this.compactionActive &&
      this.activePromptIds.size === 0 &&
      this.pendingUIRequestIds.size === 0
    );
  }

  async sendGuidance(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting) this.finishAbortState();

    const guidanceId = this.createCommandId();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(guidanceId);
        reject(new Error("Pi SDK guidance timed out"));
      }, 12000);
      try {
        this.sendWorkerCommand({
          id: guidanceId,
          type: "guidance",
          message,
          images,
          hostSystemPrompt: options?.hostSystemPrompt,
        }, (data) => {
          clearTimeout(timeout);
          if (data.type === "accepted" || data.type === "guidance_done") {
            if (data.type === "guidance_done") this.guidancePendingResponse = true;
            resolve();
          } else {
            reject(new Error(optionalString(data.error) || "Pi SDK guidance failed"));
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
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
      try {
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
      } catch (error) {
        clearTimeout(timeout);
        resolve({ supported: true, success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  async abort(): Promise<void> {
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.streamedMessageTextBuffer = "";
    this.pendingAssistantTextNeedsEmit = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    for (const toolCallId of this.activeToolCallIds) this.ignoredToolCallIds.add(toolCallId);
    this.activeToolCallIds.clear();
    this.turnActive = false;
    this.eventBuffer.clear();
    this.interruptPiSubagents("用户已中止");
    this.clearTurnFallback();
    this.emitEvent({ type: "thinking_end" });
    this.emitEvent({ type: "stream_end", content: "" });
    this.emitEvent({ type: "agent_end" });
    this.isAborting = true;

    if (!this.process) {
      this.finishAbortState();
      this.emitEvent({ type: "aborted" });
      return;
    }
    await new Promise<void>((resolve) => {
      let requestId = "";
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        resolve();
      }, 5000);
      try {
        requestId = this.sendWorkerCommand({ type: "abort" }, () => {
          clearTimeout(timeout);
          resolve();
        });
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
    this.finishAbortState();
    this.emitEvent({ type: "aborted" });
  }

  async getModels(): Promise<AgentModel[]> {
    if (this.models.length > 0) return this.models;
    if (!this.process) return [];
    if (this.compactionActive) {
      await this.waitForCompactionIdle(PI_COMPACTION_MODEL_WAIT_MS);
      if (this.models.length > 0) return this.models;
      if (!this.process) return [];
    }
    return new Promise((resolve) => {
      let requestId = "";
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        resolve([]);
      }, 4000);
      try {
        requestId = this.sendWorkerCommand({ type: "getModels" }, (data) => {
          clearTimeout(timeout);
          this.models = normalizeModels(data.models);
          resolve(this.models);
        });
      } catch {
        clearTimeout(timeout);
        resolve([]);
      }
    });
  }

  /**
   * Resolve once the running compaction (if any) settles, or after the
   * bounded timeout — whichever comes first. A compaction that never settles
   * must not block model/config RPCs forever.
   */
  private waitForCompactionIdle(timeoutMs: number): Promise<void> {
    if (!this.compactionActive) return Promise.resolve();
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (!this.compactionActive || Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
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
      try {
        requestId = this.sendWorkerCommand({ type: "setModel", provider, modelId }, (data) => {
          clearTimeout(timeout);
          if (data.type === "model_changed") {
            this.models = [];
            this.emitEvent({ type: "model_changed", model: data.model });
            resolve();
            return;
          }
          reject(new Error(optionalString(data.error) || "Pi SDK set model failed"));
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    let requestId = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (requestId) this.pendingResponses.delete(requestId);
        reject(new Error("Pi SDK set thinking level timed out"));
      }, 8000);
      try {
        requestId = this.sendWorkerCommand({ type: "setThinkingLevel", level }, (data) => {
          clearTimeout(timeout);
          if (data.type === "thinking_level_changed") {
            this.emitEvent({ type: "thinking_level_changed", level: data.level });
            resolve();
            return;
          }
          reject(new Error(optionalString(data.error) || "Pi SDK set thinking level failed"));
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async setCompactionConfig(value: AgentCompactionConfig): Promise<void> {
    const config = normalizeAgentCompactionConfig(value);
    this.compactionConfig = config;
    if (!this.process) return;
    const data = await this.requestWorkerCommand({ type: "setCompactionConfig", config }, 8_000);
    if (data.type !== "compaction_config_changed") {
      throw new Error(optionalString(data.error) || "Pi SDK set compaction config failed");
    }
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
      throw new Error(optionalString(data.error) || "Pi UI response failed");
    }
    if (id) this.pendingUIRequestIds.delete(id);
    if (this.pendingUIRequestIds.size === 0 && this.agentEndObserved) {
      this.scheduleTurnFallback(4000, true);
    } else if (this.pendingUIRequestIds.size === 0 && (this.pendingAssistantText || this.streamedText)) {
      this.scheduleTurnFallback(4000);
    }
  }

  async dispose(): Promise<void> {
    this.initPromise = null;
    this.initKey = null;
    this.clearTurnFallback();
    if (this.turnActive) this.completeTurn(true);
    this.pendingResponses.clear();
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.activeToolCallIds.clear();
    this.completedToolCallIds.clear();
    this.ignoredToolCallIds.clear();
    this.turnActive = false;
    this.agentEndObserved = false;
    this.compactionActive = false;
    this.isAborting = false;
    this.isReady = false;
    this.models = [];
    this.pendingAssistantError = "";
    this.piSubagentStarts.clear();
    this.piSubagentTerminalStates.clear();
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (!child) return;
    if (child.stdin?.writable) {
      try {
        child.stdin.write(`${JSON.stringify({ type: "dispose" })}\n`);
      } catch {
        // Continue with forced termination below.
      }
    }
    if (await this.waitForExit(child, 1500)) return;
    child.kill("SIGKILL");
    await this.waitForExit(child, 500);
  }

  private interruptPiSubagents(reason: string) {
    for (const [toolCallId, start] of this.piSubagentStarts.entries()) {
      const results = getPiSubagentTaskItems(start.args).map((item) => ({
        agent: item.label,
        task: item.prompt,
        exitCode: 1,
        status: "interrupted",
        stopReason: "aborted",
        errorMessage: reason,
      }));
      const event = buildPiSubagentEvent({
        toolCallId,
        args: start.args,
        result: { details: { results } },
        isError: true,
        error: reason,
      }, start, true);
      this.emitEvent(event);
    }
    for (const toolCallId of this.piSubagentStarts.keys()) {
      this.piSubagentTerminalStates.set(toolCallId, "interrupted");
    }
    this.piSubagentStarts.clear();
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
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
      case "context_compaction":
        if (record.phase === "started") {
          this.compactionActive = true;
          // Pi can begin a long compaction after emitting agent_end. That is
          // continuation evidence, so the missing-prompt_done fallback must
          // not settle the turn while compaction is still running.
          this.clearTurnFallback();
        } else {
          this.compactionActive = false;
        }
        this.emitEvent({
          type: "context_compaction",
          id: record.id,
          phase: record.phase,
          detail: record.error,
        });
        if (record.phase !== "started") this.refreshAgentEndFallback();
        break;
      case "history_snapshot":
        this.emitEvent({ type: "history_snapshot", messages: record.messages });
        break;
      case "turn_metadata":
        this.emitEvent({
          type: "turn_metadata",
          nativeTurnId: record.nativeTurnId,
          clientUserMessageId: record.clientUserMessageId,
        });
        break;
      case "status": {
        const statusState = record.status === "error"
          ? "error"
          : record.status === "warning"
            ? "warning"
            : record.status === "completed"
              ? "completed"
               : "running";
        if (statusState === "running") {
          // Automatic retry notifications may arrive between agent_end and
          // the next agent_start. Keep the original prompt active throughout
          // that retry delay instead of firing the terminal fallback.
          this.clearTurnFallback();
          if (record.status === "retrying") this.agentEndObserved = false;
          else this.refreshAgentEndFallback();
        }
        this.emitEvent({
          type: "process_event",
          id: record.id,
          entryType: record.status === "error" ? "error" : "status",
          kind: record.status === "error" ? "error" : "status",
          title: optionalString(record.title) || "Pi 状态更新",
          detail: record.detail,
          state: statusState,
        });
        break;
      }
      case "agent_start":
        this.beginTurn();
        break;
      // The worker emits guidance_delivered when the steer message is really
      // consumed by the agent (its message enters the agent message flow)
      // instead of when the guidance command resolves (which only queues it).
      // Emitting the response start only then keeps the guidance bubble from
      // landing in the middle of pre-guidance output.
      case "guidance_delivered":
        if (this.guidancePendingResponse) {
          this.guidancePendingResponse = false;
          this.emitEvent({ type: "guidance_response_started" });
        }
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
            this.streamedMessageTextBuffer += delta;
          }
          this.emitEventThrottled({ type: "stream_delta", delta });
        } else if (assistantEvent.type === "thinking_delta") {
          this.emitEventThrottled({ type: "thinking_delta", delta: String(assistantEvent.delta || "") });
        }
        this.refreshAgentEndFallback();
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
            this.pendingAssistantError = errorMessage || `Assistant stopped with reason: ${stopReason || "error"}`;
            this.pendingAssistantText = "";
            this.streamedText = false;
            this.streamedTextBuffer = "";
            this.streamedMessageTextBuffer = "";
            this.pendingAssistantTextNeedsEmit = false;
            this.clearTurnFallback();
            break;
          }
          this.pendingAssistantError = "";
          if (typeof message.text === "string" && message.text) {
            this.pendingAssistantText = message.text;
            this.pendingAssistantTextNeedsEmit = true;
            this.emitPendingAssistantText();
            this.streamedMessageTextBuffer = "";
          }
          const inputTokens = Number(record.inputTokens) || 0;
          const outputTokens = Number(record.outputTokens) || 0;
          const cacheInputTokens = Number(record.cacheInputTokens) || 0;
          if (inputTokens > 0 || outputTokens > 0) {
            this.emitEvent({ type: "token_usage", inputTokens, outputTokens, cacheInputTokens });
          }
        }
        this.refreshAgentEndFallback();
        break;
      case "tool_execution_start": {
        this.clearTurnFallback();
        const toolCallId = String(record.toolCallId || record.callId || record.id || "").trim();
        if (isNativeSubagentToolName(record.toolName)) {
          const toolCallId = String(record.toolCallId || record.callId || record.id || `pi-subagent-${Date.now()}`);
          if (this.piSubagentTerminalStates.has(toolCallId)) break;
          this.piSubagentStarts.set(toolCallId, {
            startedAt: Date.now(),
            args: asRecord(record.args),
            action: record.action === "resumeAgent" || record.action === "resume" ? "resumeAgent" : "spawnAgent",
          });
          this.emitEvent(buildPiSubagentEvent({ ...record, toolCallId }, this.piSubagentStarts.get(toolCallId), false));
          break;
        }
        if (!this.turnActive && this.activePromptIds.size === 0) break;
        if (toolCallId && (
          this.ignoredToolCallIds.has(toolCallId) || this.completedToolCallIds.has(toolCallId)
        )) break;
        if (toolCallId) this.activeToolCallIds.add(toolCallId);
        this.emitEvent(normalizeToolEvent("tool_start", { ...record, args: record.args, name: record.toolName }));
        break;
      }
      case "tool_execution_update": {
        this.clearTurnFallback();
        if (isNativeSubagentToolName(record.toolName)) {
          const toolCallId = String(record.toolCallId || record.callId || record.id || "pi-subagent");
          if (this.piSubagentTerminalStates.has(toolCallId)) break;
          const start = this.piSubagentStarts.get(toolCallId) || {
            startedAt: Date.now(),
            args: asRecord(record.args),
            action: record.action === "resumeAgent" || record.action === "resume" ? "resumeAgent" : "spawnAgent",
          };
          this.piSubagentStarts.set(toolCallId, start);
          this.emitEvent(buildPiSubagentEvent({ ...record, toolCallId }, start, false));
          break;
        }
        const toolCallId = String(record.toolCallId || record.callId || record.id || "").trim();
        if (!this.turnActive && this.activePromptIds.size === 0) break;
        if (toolCallId && (
          this.ignoredToolCallIds.has(toolCallId) || this.completedToolCallIds.has(toolCallId)
        )) break;
        if (toolCallId) this.activeToolCallIds.add(toolCallId);
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
        this.clearTurnFallback();
        if (isNativeSubagentToolName(record.toolName)) {
          const toolCallId = String(record.toolCallId || record.callId || record.id || "pi-subagent");
          if (this.piSubagentTerminalStates.has(toolCallId)) break;
          const start = this.piSubagentStarts.get(toolCallId) || {
            startedAt: Date.now(),
            args: asRecord(record.args),
            action: record.action === "resumeAgent" || record.action === "resume" ? "resumeAgent" : "spawnAgent",
          };
          const finalEvent = buildPiSubagentEvent({ ...record, toolCallId }, start, true);
          this.emitEvent(finalEvent);
          if (finalEvent.state !== "running") {
            this.piSubagentStarts.delete(toolCallId);
            if (isTerminalNativeSubagentStatus(finalEvent.state as NativeSubagentStatus)) {
              this.piSubagentTerminalStates.set(toolCallId, finalEvent.state as NativeSubagentStatus);
            }
          }
          break;
        }
        const toolCallId = String(record.toolCallId || record.callId || record.id || "").trim();
        if (!this.turnActive && this.activePromptIds.size === 0) break;
        if (toolCallId && (
          this.ignoredToolCallIds.has(toolCallId) || this.completedToolCallIds.has(toolCallId)
        )) break;
        const toolEvent = normalizeToolEvent("tool_end", {
          ...record,
          args: record.args,
          result: record.result,
          output: record.result,
          name: record.toolName,
        });
        this.emitEvent(withoutToolDiffPayload(toolEvent));
        const diffs = buildDiffsFromToolEvent(toolEvent);
        if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        if (toolCallId) {
          this.activeToolCallIds.delete(toolCallId);
          this.completedToolCallIds.add(toolCallId);
        }
        this.refreshAgentEndFallback();
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
        this.agentEndObserved = true;
        if (this.pendingUIRequestIds.size === 0) this.scheduleTurnFallback(4000, true);
        break;
      case "error":
        if (isContextCompactionLike(record.error, record.title, record.message)) {
          this.compactionActive = false;
          this.emitEvent({
            type: "context_compaction",
            id: record.id,
            phase: "interrupted",
            detail: record.error || record.message,
          });
          this.refreshAgentEndFallback();
          break;
        }
        if (messageId && !this.activePromptIds.delete(messageId)) break;
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
    if (!method) return;
    if (method === "notify") {
      this.emitEvent({
        type: "process_event",
        entryType: "status",
        kind: "status",
        title: optionalString(requestRecord.message) || "Pi 通知",
        state: "completed",
      });
      return;
    }
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
      message: optionalString(requestRecord.message),
      detail: request,
      questions: method === "custom" ? requestRecord.questions : undefined,
      toolName: requestRecord.toolName,
      state: "running",
    }));
  }

  private sendWorkerCommand(command: WorkerCommand, onResponse?: (data: UnknownRecord) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    const child = this.process;
    if (!child?.stdin?.writable) throw new Error("Pi SDK worker is not writable");
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
        reject(new Error(`Pi SDK ${command.type} timed out`));
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

  private refreshAgentEndFallback() {
    if (!this.agentEndObserved || this.pendingUIRequestIds.size > 0) return;
    this.scheduleTurnFallback(4000, true);
  }

  private beginTurn() {
    this.clearTurnFallback();
    this.agentEndObserved = false;
    if (this.turnActive) return;
    this.turnToken += 1;
    this.turnActive = true;
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.streamedMessageTextBuffer = "";
    this.pendingAssistantTextNeedsEmit = false;
    this.pendingAssistantText = "";
    this.pendingAssistantError = "";
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
    for (const toolCallId of this.activeToolCallIds) this.ignoredToolCallIds.add(toolCallId);
    this.activeToolCallIds.clear();
    if (this.pendingAssistantError) {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "模型请求失败",
        detail: this.pendingAssistantError,
        state: "error",
      });
      this.pendingAssistantError = "";
    }
    this.eventBuffer.flush();
    this.emitPendingAssistantText();
    this.emitEvent({ type: "stream_end", content: this.pendingAssistantText, force });
    this.emitEvent({ type: "agent_end" });
    this.pendingAssistantText = "";
    this.pendingAssistantError = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.streamedMessageTextBuffer = "";
    this.pendingAssistantTextNeedsEmit = false;
    this.turnActive = false;
    this.agentEndObserved = false;
    this.turnToken += 1;
  }

  private emitPendingAssistantText() {
    if (!this.pendingAssistantText || !this.pendingAssistantTextNeedsEmit) return;

    if (!this.streamedText) {
      this.emitEvent({ type: "stream_delta", delta: this.pendingAssistantText });
      this.streamedTextBuffer = this.pendingAssistantText;
      this.streamedText = true;
    } else if (this.streamedMessageTextBuffer !== this.pendingAssistantText) {
      const messageStart = Math.max(0, this.streamedTextBuffer.length - this.streamedMessageTextBuffer.length);
      const turnPrefix = this.streamedTextBuffer.slice(0, messageStart);
      const reconciledTurnText = `${turnPrefix}${this.pendingAssistantText}`;
      this.emitEvent({ type: "stream_snapshot", content: reconciledTurnText });
      this.streamedTextBuffer = reconciledTurnText;
    }

    this.pendingAssistantTextNeedsEmit = false;
  }

  private prepareNewTurn() {
    this.clearTurnFallback();
    // Keep non-terminal external/background subagents alive across parent turns;
    // a new prompt is not evidence that a delegated process has completed.
    this.eventBuffer.flush();
    this.pendingAssistantText = "";
    this.pendingAssistantError = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.streamedMessageTextBuffer = "";
    this.pendingAssistantTextNeedsEmit = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.activeToolCallIds.clear();
    this.completedToolCallIds.clear();
    this.ignoredToolCallIds.clear();
    this.turnActive = false;
    this.agentEndObserved = false;
    this.turnToken += 1;
  }

  private finishAbortState() {
    this.isAborting = false;
    this.pendingAssistantText = "";
    this.pendingAssistantError = "";
    this.streamedText = false;
    this.streamedTextBuffer = "";
    this.streamedMessageTextBuffer = "";
    this.pendingAssistantTextNeedsEmit = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.activeToolCallIds.clear();
    this.turnActive = false;
    this.agentEndObserved = false;
    this.compactionActive = false;
    this.piSubagentStarts.clear();
    this.turnToken += 1;
    this.eventBuffer.clear();
    this.clearTurnFallback();
  }

  private handleWorkerTermination(child: ChildProcess, title: string, detail: string) {
    if (this.process !== child) return;
    this.process = null;
    this.isReady = false;
    const error = detail || title;
    if (!this.isAborting) this.interruptPiSubagents(error);
    const handlers = [...this.pendingResponses.values()];
    this.pendingResponses.clear();
    for (const handler of handlers) handler({ type: "error", error });
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    if (this.turnActive) {
      this.pendingAssistantError = error;
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title,
        detail: error,
        state: "error",
      });
      this.completeTurn(true);
    } else if (!this.isAborting) {
      this.emitEvent({ type: "agent_disconnected", detail: error });
    }
    this.finishAbortState();
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  private emitEventThrottled(data: { type: string; [key: string]: unknown }) {
    this.eventBuffer.send(data);
  }
}
