import { join } from "path";
import { homedir } from "os";
import { execFile, spawn, type ChildProcess } from "child_process";
import * as http from "http";
import { readFileSync } from "fs";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import { buildDiffsFromToolEvent, isContextCompactionLike, normalizeQuestionProcessEvent, normalizeToolEvent } from "../../plugin-runtime/process-events";
import {
  getCommandEnv,
  getNpmPackageBinTarget,
  isWindowsShellShim,
  resolveCommand,
} from "../../utils/command-utils";
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

function resolveOpenCodeCommand(): string {
  const command = resolveCommand("opencode");
  if (!isWindowsShellShim(command)) return command;
  return getNpmPackageBinTarget(command, "opencode-ai", join("bin", "opencode.exe")) || command;
}

interface PendingOpenCodeUIRequest {
  kind: "question" | "permission";
}

type OpenCodePromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename: string; url: string };

interface OpenCodePromptBody {
  parts: OpenCodePromptPart[];
  agent?: "plan" | "build";
  model?: { providerID: string; modelID: string };
  variant?: string;
}

const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

function formatProcessDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolPart(props: unknown) {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const state = asRecord(part.state);
  const toolName =
    part.tool || part.toolName || part.name || part.type || propsRecord.tool || propsRecord.toolName || "tool";
  const toolCallId = part.id || part.callID || part.callId || propsRecord.partID || propsRecord.partId || propsRecord.id || toolName;
  const args = part.input || part.args || state.input || state.args || propsRecord.input || propsRecord.args;
  const output = part.output || part.result || state.output || state.result || propsRecord.output || propsRecord.result;
  const error = part.error || state.error || propsRecord.error;

  return {
    toolName,
    toolCallId: String(toolCallId),
    args,
    result: output,
    detail: formatProcessDetail(error ? { args, error } : output !== undefined ? { args, output } : args),
    isError: !!error,
  };
}

function normalizeEventName(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isAskUserName(value: unknown) {
  return ["ask_user", "ask_user_question", "user_ask_question"].includes(normalizeEventName(value));
}

function isToolLikePart(props: unknown) {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const partType = part.type || propsRecord.type;
  const toolName = part.tool || part.toolName || part.name || propsRecord.tool || propsRecord.toolName || partType;
  return (
    (partType && String(partType).startsWith("tool")) ||
    isAskUserName(partType) ||
    isAskUserName(toolName)
  );
}

function isToolPartComplete(props: unknown) {
  const propsRecord = asRecord(props);
  const part = asRecord(propsRecord.part || propsRecord);
  const partState = asRecord(part.state);
  const state = partState.status || part.state || part.status || propsRecord.status;
  const normalizedState = typeof state === "string" ? state.toLowerCase() : "";
  return (
    part.output !== undefined ||
    part.result !== undefined ||
    part.error !== undefined ||
    propsRecord.output !== undefined ||
    propsRecord.result !== undefined ||
    propsRecord.error !== undefined ||
    ["done", "completed", "complete", "success", "error", "failed"].includes(normalizedState)
  );
}

function readOpenCodeConfigContent(): string | undefined {
  try {
    return readFileSync(process.env.OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json"), "utf-8");
  } catch {
    return undefined;
  }
}

function buildOpenCodeConfigContent(existing?: string): string {
  const source = existing?.trim() ? existing : readOpenCodeConfigContent();
  if (!source?.trim()) {
    return JSON.stringify({ permission: "allow" });
  }

  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("permission" in parsed)) {
      return JSON.stringify({ ...parsed, permission: "allow" });
    }
  } catch {
    // Preserve caller-provided inline config if it is not plain JSON.
  }

  return source;
}

function modelSupportsImages(modelInfo: unknown): boolean {
  const info = asRecord(modelInfo);
  if (info.attachment === true || info.supportsImages === true || info.imageInput === true) return true;
  const capabilities = asRecord(info.capabilities);
  if (capabilities.attachment === true || asRecord(capabilities.input).image === true) return true;
  const modalities = asRecord(info.modalities);
  const input = info.input || modalities.input;
  return Array.isArray(input) && input.includes("image");
}

function modelSupportsReasoning(modelInfo: unknown): boolean {
  const info = asRecord(modelInfo);
  return info.reasoning === true || asRecord(info.capabilities).reasoning === true;
}

function getModelVariants(modelInfo: unknown): string[] {
  const variants = asRecord(asRecord(modelInfo).variants);
  return Object.entries(variants).flatMap(([variantId, value]) => {
    return asRecord(value).disabled === true ? [] : [variantId];
  });
}

function selectThinkingVariant(level: string, variants: string[]): string | undefined {
  const normalized = level.trim().toLowerCase();
  if (!normalized || variants.length === 0) return undefined;
  const candidates: Record<string, string[]> = {
    off: ["off", "none", "minimal"],
    none: ["none", "off", "minimal"],
    minimal: ["minimal", "low"],
    low: ["low", "minimal"],
    medium: ["medium", "default"],
    high: ["high"],
    xhigh: ["xhigh", "max", "high"],
    max: ["max", "xhigh", "high"],
  };
  return (candidates[normalized] || [normalized]).find((candidate) => variants.includes(candidate));
}

function imageExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}

function parseHttpBody(body: string): unknown {
  if (!body) return "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function createHttpError(method: string, path: string, statusCode: number, body: string) {
  const detail = body.trim().slice(0, 500);
  return new Error(`OpenCode ${method} ${path} failed (${statusCode})${detail ? `: ${detail}` : ""}`);
}

function getUIAnswerValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const answer = asRecord(value);
  const selected = Array.isArray(answer.selected) ? answer.selected : Array.isArray(answer.values) ? answer.values : null;
  if (selected) return selected.map(String).filter(Boolean);
  const scalar = answer.value ?? answer.answer ?? answer.label;
  return scalar === undefined || scalar === null || scalar === "" ? [] : [String(scalar)];
}

function getPermissionReply(response: AgentUIResponse): "once" | "always" | "reject" {
  if (response.cancelled === true) return "reject";
  const firstAnswer = Array.isArray(response.answers) ? getUIAnswerValues(response.answers[0])[0] : undefined;
  const value = String(firstAnswer || response.value || response.text || "once").toLowerCase();
  if (value === "always") return "always";
  if (["reject", "deny", "cancel", "cancelled"].includes(value)) return "reject";
  return "once";
}

// ============================================================
// OpenCode Agent - communicates with opencode serve via HTTP/SSE
// ============================================================
export class OpenCodeAgent {
  private process: ChildProcess | null = null;
  private processError: Error | null = null;
  private port = 0;
  private host = "127.0.0.1";
  private projectPath = "";
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private currentModelId: string | null = null;
  private currentProviderId: string | null = null;
  private currentThinkingLevel = "medium";
  private modelVariants = new Map<string, string[]>();
  private eventSource: ReturnType<typeof http.get> | null = null;
  private sseBuffer = "";
  private streamedContent = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private runningToolParts = new Set<string>();
  private completedToolParts = new Set<string>();
  private pendingQuestionToolParts = new Set<string>();
  private partTypes = new Map<string, string>();
  private turnActive = false;
  private activeClientMessageId: string | null = null;
  private activeAssistantMessageId: string | null = null;
  private pendingUIRequests = new Map<string, PendingOpenCodeUIRequest>();
  private eventBuffer: AgentEventBuffer;

  constructor(hppSessionId = "default", emit?: (event: UnknownRecord) => void) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  /** Start opencode serve and wait for it to be ready */
  async init(projectPath: string, existingSessionId?: string): Promise<void> {
    // If already running for same project, just restore session ID and return
    if (this.process && this.projectPath === projectPath) {
      if (existingSessionId) this.sessionId = existingSessionId;
      return;
    }

    this.projectPath = projectPath;
    this.stopSSEListener();
    await this.killProcess();
    this.processError = null;
    this.port = 10000 + Math.floor(Math.random() * 55000);
    this.sessionId = null;
    this.emitEvent({ type: "agent_init", agentId: "opencode" });

    const opencodeCommand = resolveOpenCodeCommand();
    this.process = spawn(opencodeCommand, ["serve", "--port", String(this.port), "--hostname", this.host], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindowsShellShim(opencodeCommand),
      env: getCommandEnv({
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(process.env.OPENCODE_CONFIG_CONTENT),
      }),
    });

    const childProcess = this.process!;
    childProcess.stdout?.on("data", () => undefined);
    childProcess.stderr?.on("data", (chunk: Buffer) => {
      console.log("[opencode]", chunk.toString().trim());
    });

    childProcess.on("error", (error) => {
      if (this.process !== childProcess) return;
      this.processError = error;
      this.process = null;
      if (this.turnActive) this.failActiveTurn("OpenCode process failed", error.message);
      else this.emitEvent({ type: "agent_disconnected", detail: error.message });
    });

    childProcess.on("exit", (code, signal) => {
      if (this.process !== childProcess) return;
      this.process = null;
      const detail = `OpenCode exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
      if (this.turnActive) this.failActiveTurn("OpenCode disconnected", detail);
      else this.emitEvent({ type: "agent_disconnected", detail });
    });

    await this.waitForReady(childProcess);

    // If an existing session ID was provided, verify it exists on the server.
    // Otherwise create one now so the renderer can persist the real OpenCode
    // session id before the first prompt is sent.
    if (existingSessionId) {
      const valid = await this.verifySession(existingSessionId);
      if (valid) {
        this.sessionId = existingSessionId;
        console.log("[opencode] Resumed session:", existingSessionId);
      } else {
        console.log("[opencode] Session", existingSessionId, "not found on server, will create new");
      }
    }

    if (!this.sessionId) {
      const createdSessionId = await this.createSession();
      if (createdSessionId) {
        console.log("[opencode] Created session:", createdSessionId);
      }
    }
  }

  /** Verify a session exists on the server */
  private async verifySession(sessionId: string): Promise<boolean> {
    try {
      const result = await this.httpGet(`/session/${sessionId}`);
      return asRecord(result).id !== undefined;
    } catch {
      return false;
    }
  }

  private async waitForReady(childProcess: ChildProcess): Promise<void> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      if (this.process !== childProcess) {
        throw this.processError || new Error("OpenCode exited before becoming ready");
      }
      try {
        const result = await this.httpGet("/global/health");
        if (asRecord(result).healthy) {
          this.emitEvent({ type: "agent_ready", agentId: "opencode", mock: false });
          return;
        }
      } catch {
        // server not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.killProcess();
    throw new Error("OpenCode server did not become ready within 30 seconds");
  }

  /** Create a new opencode session, or reuse existing if session ID is already set */
  async createSession(): Promise<string | null> {
    // Reuse existing session ID if available
    if (this.sessionId) return this.sessionId;

    try {
      const result = await this.httpPost("/session", {});
      const sessionId = asRecord(result).id;
      if (sessionId !== undefined && sessionId !== null) {
        this.sessionId = String(sessionId);
        return this.sessionId;
      }
    } catch (e) {
      console.error("[opencode] createSession failed:", e);
    }
    return null;
  }

  /** Send a message to the opencode session */
  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (!this.sessionId) {
      await this.createSession();
    }
    if (!this.sessionId) {
      this.emitEvent({ type: "stream_start", role: "assistant" });
      this.emitEvent({ type: "stream_delta", delta: "无法创建会话，请检查 opencode 是否已安装。" });
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      return;
    }

    this.emitEvent({ type: "stream_start", role: "assistant" });

    try {
      await this.startSSEListener();
      if (!this.eventSource) throw new Error("OpenCode event stream closed before the prompt was sent");
      const parts: OpenCodePromptPart[] = [{ type: "text", text: message }];
      if (images?.length) {
        images.forEach((image, index) => {
          const mimeType = image.mimeType || "image/png";
          parts.push({
            type: "file",
            mime: mimeType,
            filename: `image-${index + 1}.${imageExtension(mimeType)}`,
            url: `data:${mimeType};base64,${image.data}`,
          });
        });
      }
      const body: OpenCodePromptBody = { parts };
      this.activeClientMessageId = options?.clientMessageId?.trim() || null;
      this.activeAssistantMessageId = null;
      this.turnActive = true;
      if (options?.planModeEnabled || options?.permissionMode === "plan") {
        body.agent = "plan";
      } else {
        body.agent = "build";
      }
      if (this.currentModelId && this.currentProviderId) {
        body.model = { providerID: this.currentProviderId, modelID: this.currentModelId };
        const variants = this.modelVariants.get(`${this.currentProviderId}:${this.currentModelId}`) || [];
        const variant = selectThinkingVariant(this.currentThinkingLevel, variants);
        if (variant) body.variant = variant;
      }
      await this.httpPost(`/session/${this.sessionId}/prompt_async`, body);
    } catch (e) {
      console.error("[opencode] sendMessage failed:", e);
      this.emitEvent({ type: "stream_delta", delta: `\n\n发送失败: ${e}` });
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      this.turnActive = false;
      this.stopSSEListener();
      this.pendingUIRequests.clear();
      this.clearActiveTurn();
    }
  }

  isIdle(): boolean {
    return (
      !this.turnActive &&
      !this.eventSource &&
      !this.idleTimer &&
      this.runningToolParts.size === 0 &&
      this.pendingQuestionToolParts.size === 0
    );
  }

  /** Listen to SSE events for streaming responses */
  private startSSEListener(): Promise<void> {
    this.stopSSEListener();
    this.clearActiveTurn();
    this.sseBuffer = "";
    this.streamedContent = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();
    this.pendingQuestionToolParts.clear();
    this.partTypes.clear();

    return new Promise((resolve, reject) => {
      let connected = false;
      const req = http.get(
        `http://${this.host}:${this.port}/event`,
        { timeout: 10000 },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            this.eventSource = null;
            req.destroy();
            reject(new Error(`OpenCode event stream failed (${res.statusCode || 0})`));
            return;
          }
          connected = true;
          req.setTimeout(0);
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => {
            this.sseBuffer += chunk;
            this.processSSEBuffer();
          });
          res.on("end", () => this.handleSSEDisconnect(req, "OpenCode event stream ended"));
          res.on("aborted", () => this.handleSSEDisconnect(req, "OpenCode event stream was aborted"));
          res.on("close", () => this.handleSSEDisconnect(req, "OpenCode event stream closed"));
          res.on("error", (error) => this.handleSSEDisconnect(req, error.message));
          resolve();
        }
      );

      req.on("error", (error) => {
        if (this.eventSource === req) this.eventSource = null;
        if (!connected) reject(error);
        else this.handleSSEDisconnect(req, error.message);
      });
      req.on("timeout", () => {
        if (this.eventSource === req) this.eventSource = null;
        req.destroy();
        if (!connected) reject(new Error("OpenCode event stream timed out"));
      });
      this.eventSource = req;
    });
  }

  private handleSSEDisconnect(request: ReturnType<typeof http.get>, detail: string) {
    if (this.eventSource !== request) return;
    this.eventSource = null;
    if (this.turnActive) this.failActiveTurn("OpenCode event stream disconnected", detail);
  }

  private processSSEBuffer() {
    const lines = this.sseBuffer.split("\n");
    this.sseBuffer = lines.pop() || "";

    for (const line of lines) {
      // OpenCode SSE format: each line is "data: {json}"
      // Event type is inside the JSON "type" field
      if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }
        if (isRecord(parsed) && typeof parsed.type === "string") {
          this.handleSSEEvent(parsed.type, parsed);
        }
      }
    }
  }

  private handleSSEEvent(eventType: string, data: unknown) {
    const dataRecord = asRecord(data);
    const props = asRecord(dataRecord.properties || dataRecord);
    const part = asRecord(props.part || props);
    const info = asRecord(props.info);
    const eventSessionId = String(props.sessionID || part.sessionID || info.sessionID || "");
    if (this.sessionId && eventSessionId && eventSessionId !== this.sessionId) return;
    if (
      isContextCompactionLike(
        eventType,
        props.type,
        props.name,
        props.title,
        props.message,
        props.status,
        part.type,
        part.name,
        part.title,
        part.message
      )
    ) {
      this.emitEvent({ type: "context_compaction", id: part.id || props.partID || props.partId || props.id || dataRecord.id });
      return;
    }

    switch (eventType) {
      case "question.asked":
      case "question.v2.asked":
        if (typeof props.id === "string") {
          this.cancelIdleTimer();
          this.pendingUIRequests.set(props.id, { kind: "question" });
          this.emitEvent(normalizeQuestionProcessEvent({
            type: eventType,
            requestId: props.id,
            method: "opencode.question",
            questions: props.questions,
            detail: props,
          }));
        }
        break;
      case "permission.asked":
      case "permission.v2.asked":
        if (typeof props.id === "string") {
          this.cancelIdleTimer();
          const action = String(props.action || props.permission || "requested action");
          const resources = Array.isArray(props.resources)
            ? props.resources.map(String)
            : Array.isArray(props.patterns)
              ? props.patterns.map(String)
              : [];
          this.pendingUIRequests.set(props.id, { kind: "permission" });
          this.emitEvent(normalizeQuestionProcessEvent({
            type: eventType,
            requestId: props.id,
            method: "opencode.permission",
            questions: [{
              header: "Permission",
              question: resources.length > 0 ? `${action}: ${resources.join(", ")}` : action,
              options: [
                { label: "Allow once", value: "once" },
                { label: "Always allow", value: "always" },
                { label: "Reject", value: "reject" },
              ],
            }],
            detail: props,
          }));
        }
        break;
      case "question.replied":
      case "question.rejected":
      case "question.v2.replied":
      case "question.v2.rejected":
      case "permission.replied":
      case "permission.v2.replied":
        {
          const requestId = typeof props.id === "string" ? props.id : typeof props.requestID === "string" ? props.requestID : "";
          if (requestId) this.pendingUIRequests.delete(requestId);
        }
        break;
      case "message.updated":
        if (info.role === "assistant") this.recordAssistantMessageId(info.id);
        break;
      case "message.part.added":
      case "message.part.updated": {
        this.rememberPartType(part);
        if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;

          if (isAskUserName(tool.toolName)) {
            if (!this.pendingQuestionToolParts.has(tool.toolCallId)) {
              this.pendingQuestionToolParts.add(tool.toolCallId);
              this.runningToolParts.add(tool.toolCallId);
              this.emitEvent(normalizeQuestionProcessEvent({
                ...tool,
                id: tool.toolCallId,
                requestId: tool.toolCallId,
                method: tool.toolName,
                args: tool.args,
                detail: tool.args || tool.detail,
              }));
            }
            break;
          }

          if (!this.runningToolParts.has(tool.toolCallId)) {
            this.runningToolParts.add(tool.toolCallId);
            this.emitEvent(normalizeToolEvent("tool_start", tool));
          } else if (tool.detail) {
            this.emitEvent(normalizeToolEvent("tool_start", tool));
          }

          if (isToolPartComplete(props)) {
            const toolEvent = normalizeToolEvent("tool_end", tool);
            this.emitEvent(toolEvent);
            const diffs = buildDiffsFromToolEvent(toolEvent);
            if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
            this.runningToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
          }
        } else if (props.delta) {
          this.emitPartDelta(part.type, props.delta);
        }
        break;
      }
      case "message.part.done":
      case "message.part.removed": {
        const partId = String(part.id || props.partID || props.partId || "");
        const partType = part.type || props.type || this.partTypes.get(partId);
        if (this.isReasoningPartType(partType)) {
          this.emitEvent({ type: "thinking_end" });
        } else if (isToolLikePart(props)) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;

          if (isAskUserName(tool.toolName)) {
            this.runningToolParts.delete(tool.toolCallId);
            this.pendingQuestionToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
            break;
          }

          const toolEvent = normalizeToolEvent("tool_end", tool);
          this.emitEvent(toolEvent);
          const diffs = buildDiffsFromToolEvent(toolEvent);
          if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
          this.runningToolParts.delete(tool.toolCallId);
          this.completedToolParts.add(tool.toolCallId);
        }
        if (partId) this.partTypes.delete(partId);
        break;
      }
      case "message.part.delta": {
        // Cancel pending idle handling - main agent may still be processing
        this.cancelIdleTimer();
        const partId = String(props.partID || props.partId || part.id || "");
        const partType = props.field === "thinking"
          ? "thinking"
          : part.type || this.partTypes.get(partId);
        this.emitPartDelta(partType, props.delta);
        break;
      }
      case "session.status": {
        const status = asRecord(props.status);
        const statusType = status.type || props.status;
        if (statusType === "busy") {
          // Session is busy - cancel pending idle timer (sub-agent done but main agent continues)
          this.cancelIdleTimer();
        } else if (statusType === "idle") {
          // Session is truly idle - schedule stream end with a small delay
          // to catch trailing message.part.delta events
          this.scheduleIdleEnd();
        }
        break;
      }
      case "session.error": {
        this.cancelIdleTimer();
        const err = asRecord(props.error);
        const errData = asRecord(err.data);
        const message =
          typeof errData.message === "string" ? errData.message :
          typeof err.message === "string" ? err.message :
          "OpenCode request failed";
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          title: "OpenCode 错误",
          detail: message,
          state: "error",
        });
        this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${message || "未知错误"}` });
        this.turnActive = false;
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        this.stopSSEListener();
        this.pendingUIRequests.clear();
        this.clearActiveTurn();
        break;
      }
      case "session.diff": {
        const diffs = props.diff;
        if (Array.isArray(diffs) && diffs.length > 0) {
          this.emitEvent({ type: "diff_update", diffs });
        }
        break;
      }
      case "session.idle": {
        // Don't end immediately - sub-agent may have finished but main agent continues
        // Schedule a delayed end; if session.status becomes "busy" again, the timer is cancelled
        this.scheduleIdleEnd();
        break;
      }
    }
  }

  private cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleEnd() {
    this.cancelIdleTimer();
    if (this.pendingUIRequests.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.streamedContent) {
        this.turnActive = false;
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        this.stopSSEListener();
        this.pendingUIRequests.clear();
        this.clearActiveTurn();
      } else {
        // Fallback: fetch final message via REST (for older opencode versions)
        this.fetchAssistantMessage();
      }
    }, 800);
  }

  /** Fetch the latest assistant message content via REST after session.idle */
  private async fetchAssistantMessage() {
    if (!this.sessionId) {
      this.turnActive = false;
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      this.stopSSEListener();
      this.pendingUIRequests.clear();
      this.clearActiveTurn();
      return;
    }

    try {
      const messages = await this.httpGet(`/session/${this.sessionId}/message`);
      if (Array.isArray(messages)) {
        // Find the last assistant message
        const assistantMsg = [...messages]
          .reverse()
          .map((message) => asRecord(message))
          .find((message) => asRecord(message.info).role === "assistant");
        this.recordAssistantMessageId(asRecord(assistantMsg?.info).id);
        const assistantParts = Array.isArray(assistantMsg?.parts) ? assistantMsg.parts : [];
        if (assistantParts.length > 0) {
          for (const rawPart of assistantParts) {
            const part = asRecord(rawPart);
            if (part.type === "text" && typeof part.text === "string") {
              this.emitEvent({ type: "stream_delta", delta: part.text });
            } else if (part.type === "thinking" && typeof part.text === "string") {
              this.emitEvent({ type: "thinking_delta", delta: part.text });
              this.emitEvent({ type: "thinking_end" });
            }
          }
        } else if (asRecord(assistantMsg?.info).error) {
          // Message completed with error
          const error = asRecord(asRecord(assistantMsg?.info).error);
          const errorData = asRecord(error.data);
          const errMsg =
            typeof errorData.message === "string" ? errorData.message :
            typeof error.message === "string" ? error.message :
            "请求失败";
          this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${errMsg}` });
        } else {
          this.emitEvent({ type: "stream_delta", delta: "\n\n(无响应内容)" });
        }
      }
    } catch (e) {
      this.emitEvent({ type: "stream_delta", delta: `\n\n获取响应失败: ${e}` });
    }

    this.turnActive = false;
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
    this.stopSSEListener();
    this.pendingUIRequests.clear();
    this.clearActiveTurn();
  }

  private stopSSEListener() {
    this.cancelIdleTimer();
    const request = this.eventSource;
    this.eventSource = null;
    request?.destroy();
  }

  /** Abort the current response */
  async abort() {
    let errorMessage = "";
    if (this.sessionId) {
      try {
        await this.httpPost(`/session/${this.sessionId}/abort`, {});
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
    this.turnActive = false;
    this.stopSSEListener();
    this.runningToolParts.clear();
    this.pendingQuestionToolParts.clear();
    this.partTypes.clear();
    this.pendingUIRequests.clear();
    this.clearActiveTurn();
    this.emitEvent({ type: "aborted", detail: errorMessage || undefined });
  }

  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    const sourceSessionId = target.sourceSessionFilePath || this.sessionId;
    if (!sourceSessionId) {
      return {
        supported: true,
        success: false,
        reason: "OpenCode source session is unavailable",
      };
    }

    if (!target.targetTurnId && (target.rollbackUserMessageCount || 0) > 0) {
      return {
        supported: true,
        success: false,
        reason: "OpenCode native message id is unavailable for this historical turn",
      };
    }

    try {
      const body = target.targetTurnId ? { messageID: target.targetTurnId } : {};
      const result = asRecord(await this.httpPost(`/session/${sourceSessionId}/fork`, body));
      const forkedSessionId = typeof result.id === "string" ? result.id : "";
      if (!forkedSessionId) {
        return {
          supported: true,
          success: false,
          reason: "OpenCode did not return a forked session id",
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

  /** Get available models from providers */
  async getModels(): Promise<AgentModel[]> {
    console.log("[opencode] getModels called, cached:", this.models.length, "port:", this.port);
    if (this.models.length > 0) return this.models;

    this.modelVariants.clear();
    try {
      const result = asRecord(await this.httpGet("/config/providers"));
      if (Array.isArray(result.providers)) {
        const models: AgentModel[] = [];
        for (const rawProvider of result.providers) {
          const provider = asRecord(rawProvider);
          const providerIdValue = provider.id || provider.name;
          if (providerIdValue === undefined || providerIdValue === null) continue;
          const providerId = String(providerIdValue);
          if (Array.isArray(provider.models)) {
            for (const rawModel of provider.models) {
              const model = asRecord(rawModel);
              const modelId = model.id || model.name;
              if (modelId === undefined || modelId === null) continue;
              const normalizedModelId = String(modelId);
              this.modelVariants.set(`${providerId}:${normalizedModelId}`, getModelVariants(model));
              models.push({
                id: normalizedModelId,
                name: String(model.name || model.id || modelId),
                provider: providerId,
                reasoning: modelSupportsReasoning(model),
                supportsImages: modelSupportsImages(model),
              });
            }
          } else if (isRecord(provider.models)) {
            // models may be a record: { modelId: modelInfo }
            for (const [modelId, modelInfo] of Object.entries(provider.models)) {
              const model = asRecord(modelInfo);
              this.modelVariants.set(`${providerId}:${modelId}`, getModelVariants(modelInfo));
              models.push({
                id: modelId,
                name: typeof model.name === "string" ? model.name : modelId,
                provider: providerId,
                reasoning: modelSupportsReasoning(modelInfo),
                supportsImages: modelSupportsImages(modelInfo),
              });
            }
          } else {
            const defaults = asRecord(result.default);
            const defaultModel = defaults[providerId];
            if (defaultModel === undefined || defaultModel === null) continue;
            models.push({
              id: String(defaultModel),
              name: String(defaultModel),
              provider: providerId,
              reasoning: false,
              supportsImages: false,
            });
          }
        }
        if (models.length > 0) {
          this.models = models;
          return this.models;
        }
      }
    } catch (e) {
      console.error("[opencode] getModels failed:", e);
    }

    return this.models;
  }

  /** Set model for the session - stored and applied per-message */
  async setModel(provider: string, modelId: string) {
    this.currentModelId = modelId;
    this.currentProviderId = provider;
    this.emitEvent({ type: "model_changed", model: { id: modelId, provider } });
  }

  /** Set the OpenCode model variant used by subsequent prompts. */
  async setThinkingLevel(level: string) {
    this.currentThinkingLevel = level;
    this.emitEvent({ type: "thinking_level_changed", level });
  }

  sendUIResponse(response: AgentUIResponse) {
    void this.respondToUIRequest(response).catch((error) => {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        title: "OpenCode response failed",
        detail: error instanceof Error ? error.message : String(error),
        state: "error",
      });
    });
  }

  /** For OpenCode, the session ID serves as the session file path equivalent */
  get sessionFilePath(): string | null { return this.sessionId; }

  /** Dispose and clean up */
  async dispose() {
    this.cancelIdleTimer();
    this.stopSSEListener();
    this.eventBuffer.flush();
    await this.killProcess();
  }

  private async killProcess() {
    const childProcess = this.process;
    this.process = null;
    childProcess?.stdin?.end();
    this.turnActive = false;
    this.sessionId = null;
    this.runningToolParts.clear();
    this.pendingQuestionToolParts.clear();
    this.partTypes.clear();
    this.pendingUIRequests.clear();
    this.models = [];
    this.modelVariants.clear();
    this.clearActiveTurn();
    if (childProcess) await this.killProcessTree(childProcess);
  }

  private async killProcessTree(childProcess: ChildProcess) {
    if (process.platform !== "win32" || !childProcess.pid) {
      childProcess.kill("SIGKILL");
      return;
    }
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], { windowsHide: true }, () => resolve());
    });
  }

  // ---- HTTP helpers ----

  private httpGet(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${this.host}:${this.port}${path}`,
        { timeout: 10000 },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const statusCode = res.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(createHttpError("GET", path, statusCode, body));
              return;
            }
            resolve(parseHttpBody(body));
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
  }

  private httpPost(path: string, data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = http.request(
        `http://${this.host}:${this.port}${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 30000,
        },
        (res) => {
          let resBody = "";
          res.on("data", (chunk) => (resBody += chunk));
          res.on("end", () => {
            const statusCode = res.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(createHttpError("POST", path, statusCode, resBody));
              return;
            }
            resolve(parseHttpBody(resBody));
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(body);
      req.end();
    });
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  private failActiveTurn(title: string, detail: string) {
    const shouldFinish = this.turnActive || !!this.eventSource;
    this.turnActive = false;
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
    this.stopSSEListener();
    this.pendingUIRequests.clear();
    this.clearActiveTurn();
  }

  private async respondToUIRequest(response: AgentUIResponse) {
    const requestId = typeof response.id === "string"
      ? response.id
      : typeof response.requestId === "string"
        ? response.requestId
        : "";
    if (!requestId) throw new Error("OpenCode UI response is missing request id");
    const pending = this.pendingUIRequests.get(requestId);
    const method = typeof response.method === "string" ? response.method : "";
    const kind = pending?.kind || (method.includes("permission") ? "permission" : method.includes("question") ? "question" : undefined);
    if (!kind) throw new Error(`Unknown OpenCode UI request: ${requestId}`);

    if (kind === "permission") {
      await this.httpPost(`/permission/${encodeURIComponent(requestId)}/reply`, {
        reply: getPermissionReply(response),
      });
    } else if (response.cancelled === true) {
      await this.httpPost(`/question/${encodeURIComponent(requestId)}/reject`, {});
    } else {
      const rawAnswers = Array.isArray(response.answers) ? response.answers : [];
      const answers = rawAnswers.length > 0
        ? rawAnswers.map(getUIAnswerValues)
        : [[String(response.text || response.value || "")].filter(Boolean)];
      await this.httpPost(`/question/${encodeURIComponent(requestId)}/reply`, { answers });
    }
    this.pendingUIRequests.delete(requestId);
  }

  private recordAssistantMessageId(value: unknown) {
    if (!this.activeClientMessageId || typeof value !== "string" || !value.startsWith("msg")) return;
    if (value === this.activeAssistantMessageId) return;
    this.activeAssistantMessageId = value;
    this.emitEvent({
      type: "turn_metadata",
      nativeTurnId: value,
      clientUserMessageId: this.activeClientMessageId,
    });
  }

  private rememberPartType(part: UnknownRecord) {
    const partId = typeof part.id === "string" ? part.id : "";
    const partType = typeof part.type === "string" ? part.type : "";
    if (partId && partType) this.partTypes.set(partId, partType);
  }

  private isReasoningPartType(value: unknown) {
    const normalized = normalizeEventName(value);
    return normalized === "reasoning" || normalized === "thinking";
  }

  private emitPartDelta(partType: unknown, delta: unknown) {
    if (delta === undefined || delta === null || delta === "") return;
    this.streamedContent = true;
    if (this.isReasoningPartType(partType)) {
      this.emitEvent({ type: "thinking_delta", delta: String(delta) });
      return;
    }
    this.emitEvent({ type: "stream_delta", delta: String(delta) });
  }

  private clearActiveTurn() {
    this.activeClientMessageId = null;
    this.activeAssistantMessageId = null;
    this.partTypes.clear();
  }
}
