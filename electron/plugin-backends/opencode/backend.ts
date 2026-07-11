import { join } from "path";
import { homedir } from "os";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";
import { readFileSync } from "fs";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import { buildDiffsFromToolEvent, isContextCompactionLike, normalizeQuestionProcessEvent, normalizeToolEvent } from "../../plugin-runtime/process-events";
import { getCommandEnv, isWindowsShellShim, resolveCommand } from "../../utils/command-utils";
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
}

type OpenCodePromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename: string; url: string };

interface OpenCodePromptBody {
  parts: OpenCodePromptPart[];
  agent?: "plan" | "build";
  model?: { providerID: string; modelID: string };
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
  const toolName =
    part.tool || part.toolName || part.name || part.type || propsRecord.tool || propsRecord.toolName || "tool";
  const toolCallId = part.id || part.callID || part.callId || propsRecord.partID || propsRecord.partId || propsRecord.id || toolName;
  const args = part.input || part.args || propsRecord.input || propsRecord.args;
  const output = part.output || part.result || propsRecord.output || propsRecord.result;
  const error = part.error || propsRecord.error;

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
  return ["ask_user", "ask_user_question", "user_ask_question", "droid.ask_user"].includes(normalizeEventName(value));
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
  const modalities = asRecord(info.modalities);
  const input = info.input || modalities.input;
  return Array.isArray(input) && input.includes("image");
}

function imageExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "png";
}

// ============================================================
// OpenCode Agent - communicates with opencode serve via HTTP/SSE
// ============================================================
export class OpenCodeAgent {
  private process: ChildProcess | null = null;
  private port = 0;
  private host = "127.0.0.1";
  private projectPath = "";
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private currentModelId: string | null = null;
  private currentProviderId: string | null = null;
  private eventSource: ReturnType<typeof http.get> | null = null;
  private sseBuffer = "";
  private streamedContent = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private runningToolParts = new Set<string>();
  private completedToolParts = new Set<string>();
  private pendingQuestionToolParts = new Set<string>();
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
    this.killProcess();
    this.port = 10000 + Math.floor(Math.random() * 55000);
    this.sessionId = null;
    this.emitEvent({ type: "agent_init", agentId: "opencode" });

    const opencodeCommand = resolveCommand("opencode");
    this.process = spawn(opencodeCommand, ["serve", "--port", String(this.port), "--hostname", this.host], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindowsShellShim(opencodeCommand),
      env: getCommandEnv({
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(process.env.OPENCODE_CONFIG_CONTENT),
      }),
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      console.log("[opencode]", chunk.toString().trim());
    });

    this.process.on("exit", () => {
      this.process = null;
      this.emitEvent({ type: "agent_disconnected" });
    });

    await this.waitForReady();

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

  private async waitForReady(): Promise<void> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
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
    this.emitEvent({ type: "agent_ready", agentId: "opencode", mock: true });
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
    this.startSSEListener();

    try {
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
      if (options?.planModeEnabled || options?.permissionMode === "plan") {
        body.agent = "plan";
      } else {
        body.agent = "build";
      }
      if (this.currentModelId && this.currentProviderId) {
        body.model = { providerID: this.currentProviderId, modelID: this.currentModelId };
      }
      await this.httpPost(`/session/${this.sessionId}/prompt_async`, body);
    } catch (e) {
      console.error("[opencode] sendMessage failed:", e);
      this.emitEvent({ type: "stream_delta", delta: `\n\n发送失败: ${e}` });
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      this.stopSSEListener();
    }
  }

  isIdle(): boolean {
    return (
      !this.eventSource &&
      !this.idleTimer &&
      this.runningToolParts.size === 0 &&
      this.pendingQuestionToolParts.size === 0
    );
  }

  /** Listen to SSE events for streaming responses */
  private startSSEListener() {
    this.stopSSEListener();
    this.sseBuffer = "";
    this.streamedContent = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();
    this.pendingQuestionToolParts.clear();

    const req = http.get(
      `http://${this.host}:${this.port}/event`,
      (res) => {
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          this.sseBuffer += chunk;
          this.processSSEBuffer();
        });
        res.on("end", () => this.stopSSEListener());
        res.on("error", () => this.stopSSEListener());
      }
    );

    req.on("error", () => this.stopSSEListener());
    this.eventSource = req;
  }

  private processSSEBuffer() {
    const lines = this.sseBuffer.split("\n");
    this.sseBuffer = lines.pop() || "";

    for (const line of lines) {
      // OpenCode SSE format: each line is "data: {json}"
      // Event type is inside the JSON "type" field
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6).trim();
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
      case "message.part.added":
      case "message.part.updated": {
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
        }
        break;
      }
      case "message.part.done":
      case "message.part.removed": {
        const partType = part.type || props.type;
        if (partType === "thinking") {
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
        break;
      }
      case "message.part.delta": {
        // Cancel pending idle handling - main agent may still be processing
        this.cancelIdleTimer();
        if (props.field === "text" && props.delta) {
          this.streamedContent = true;
          this.emitEvent({ type: "stream_delta", delta: String(props.delta) });
        } else if (props.field === "thinking" && props.delta) {
          this.streamedContent = true;
          this.emitEvent({ type: "thinking_delta", delta: String(props.delta) });
        }
        break;
      }
      case "session.status": {
        const status = asRecord(props.status);
        const statusType = status.type || props.status;
        if (statusType === "busy") {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            title: "OpenCode 正在处理",
            state: "running",
          });
          // Session is busy - cancel pending idle timer (sub-agent done but main agent continues)
          this.cancelIdleTimer();
        } else if (statusType === "idle") {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            title: "OpenCode 处理完成",
            state: "completed",
          });
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
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        this.stopSSEListener();
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
        this.emitEvent({
          type: "process_event",
          entryType: "status",
          title: "OpenCode 空闲",
          state: "completed",
        });
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
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.streamedContent) {
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        this.stopSSEListener();
      } else {
        // Fallback: fetch final message via REST (for older opencode versions)
        this.fetchAssistantMessage();
      }
    }, 800);
  }

  /** Fetch the latest assistant message content via REST after session.idle */
  private async fetchAssistantMessage() {
    if (!this.sessionId) {
      this.emitEvent({ type: "stream_end" });
      this.emitEvent({ type: "agent_end" });
      this.stopSSEListener();
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

    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
    this.stopSSEListener();
  }

  private stopSSEListener() {
    this.cancelIdleTimer();
    if (this.eventSource) {
      this.eventSource.destroy();
      this.eventSource = null;
    }
  }

  /** Abort the current response */
  async abort() {
    if (this.sessionId) {
      try {
        await this.httpPost(`/session/${this.sessionId}/abort`, {});
      } catch {
        // ignore
      }
    }
    this.stopSSEListener();
    this.runningToolParts.clear();
    this.pendingQuestionToolParts.clear();
  }

  /** Get available models from providers */
  async getModels(): Promise<AgentModel[]> {
    console.log("[opencode] getModels called, cached:", this.models.length, "port:", this.port);
    if (this.models.length > 0) return this.models;

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
              models.push({
                id: String(modelId),
                name: String(model.name || model.id || modelId),
                provider: providerId,
                reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
                supportsImages: modelSupportsImages(model),
              });
            }
          } else if (isRecord(provider.models)) {
            // models may be a record: { modelId: modelInfo }
            for (const [modelId, modelInfo] of Object.entries(provider.models)) {
              const model = asRecord(modelInfo);
              models.push({
                id: modelId,
                name: typeof model.name === "string" ? model.name : modelId,
                provider: providerId,
                reasoning: typeof model.reasoning === "boolean" ? model.reasoning : false,
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

  /** Set thinking level - opencode does not have a direct equivalent */
  async setThinkingLevel(_level: string) {
    this.emitEvent({ type: "thinking_level_changed", level: _level });
  }

  sendUIResponse(_response: AgentUIResponse) {
    // OpenCode ask-user style events are surfaced in the process trace; the
    // current HTTP/SSE bridge does not expose a matching UI response endpoint.
  }

  /** For OpenCode, the session ID serves as the session file path equivalent */
  get sessionFilePath(): string | null { return this.sessionId; }

  /** Dispose and clean up */
  dispose() {
    this.cancelIdleTimer();
    this.stopSSEListener();
    this.eventBuffer.flush();
    this.killProcess();
  }

  private killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.sessionId = null;
    this.runningToolParts.clear();
    this.pendingQuestionToolParts.clear();
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
            try { resolve(JSON.parse(body)); } catch { resolve(body); }
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
            try { resolve(JSON.parse(resBody)); } catch { resolve(resBody); }
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
}
