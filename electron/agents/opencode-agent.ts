import { BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

function formatProcessDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolPart(props: any) {
  const part = props.part || props;
  const toolName =
    part.tool || part.toolName || part.name || part.type || props.tool || props.toolName || "tool";
  const toolCallId = part.id || part.callID || part.callId || props.partID || props.partId || props.id || toolName;
  const args = part.input || part.args || props.input || props.args;
  const output = part.output || part.result || props.output || props.result;
  const error = part.error || props.error;

  return {
    toolName,
    toolCallId: String(toolCallId),
    detail: formatProcessDetail(error ? { args, error } : output !== undefined ? { args, output } : args),
    isError: !!error,
  };
}

function isToolPartComplete(props: any) {
  const part = props.part || props;
  const state = part.state?.status || part.state || part.status || props.status;
  const normalizedState = typeof state === "string" ? state.toLowerCase() : "";
  return (
    part.output !== undefined ||
    part.result !== undefined ||
    part.error !== undefined ||
    props.output !== undefined ||
    props.result !== undefined ||
    props.error !== undefined ||
    ["done", "completed", "complete", "success", "error", "failed"].includes(normalizedState)
  );
}

// ============================================================
// OpenCode Agent - communicates with opencode serve via HTTP/SSE
// ============================================================
export class OpenCodeAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private port = 0;
  private host = "127.0.0.1";
  private projectPath = "";
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private currentModelId: string | null = null;
  private currentProviderId: string | null = null;
  private eventSource: ReturnType<typeof http.get> | null = null;
  private eventBuffer = "";
  private streamedContent = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private runningToolParts = new Set<string>();
  private completedToolParts = new Set<string>();

  setWindow(win: BrowserWindow) {
    this.window = win;
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

    this.process = spawn("opencode", ["serve", "--port", String(this.port), "--hostname", this.host], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "true" },
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
      return !!(result && (result as any).id);
    } catch {
      return false;
    }
  }

  private async waitForReady(): Promise<void> {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.httpGet("/global/health");
        if (result && (result as any).healthy) {
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
      if (result && (result as any).id) {
        this.sessionId = (result as any).id;
        return this.sessionId;
      }
    } catch (e) {
      console.error("[opencode] createSession failed:", e);
    }
    return null;
  }

  /** Send a message to the opencode session */
  async sendMessage(message: string): Promise<void> {
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
      const body: any = { parts: [{ type: "text", text: message }] };
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

  /** Listen to SSE events for streaming responses */
  private startSSEListener() {
    this.stopSSEListener();
    this.eventBuffer = "";
    this.streamedContent = false;
    this.runningToolParts.clear();
    this.completedToolParts.clear();

    const req = http.get(
      `http://${this.host}:${this.port}/event`,
      (res) => {
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          this.eventBuffer += chunk;
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
    const lines = this.eventBuffer.split("\n");
    this.eventBuffer = lines.pop() || "";

    for (const line of lines) {
      // OpenCode SSE format: each line is "data: {json}"
      // Event type is inside the JSON "type" field
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let parsed: any;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }
        if (parsed.type) {
          this.handleSSEEvent(parsed.type, parsed);
        }
      }
    }
  }

  private handleSSEEvent(eventType: string, data: any) {
    const props = data.properties || data;

    switch (eventType) {
      case "message.part.added":
      case "message.part.updated": {
        const partType = props.part?.type || props.type;
        if (partType && String(partType).startsWith("tool")) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;

          if (!this.runningToolParts.has(tool.toolCallId)) {
            this.runningToolParts.add(tool.toolCallId);
            this.emitEvent({
              type: "tool_start",
              toolName: tool.toolName,
              toolCallId: tool.toolCallId,
              detail: tool.detail,
            });
          } else if (tool.detail) {
            this.emitEvent({
              type: "tool_start",
              toolName: tool.toolName,
              toolCallId: tool.toolCallId,
              detail: tool.detail,
            });
          }

          if (isToolPartComplete(props)) {
            this.emitEvent({
              type: "tool_end",
              toolName: tool.toolName,
              toolCallId: tool.toolCallId,
              detail: tool.detail,
              isError: tool.isError,
            });
            this.runningToolParts.delete(tool.toolCallId);
            this.completedToolParts.add(tool.toolCallId);
          }
        }
        break;
      }
      case "message.part.done":
      case "message.part.removed": {
        const partType = props.part?.type || props.type;
        if (partType && String(partType).startsWith("tool")) {
          const tool = summarizeToolPart(props);
          if (this.completedToolParts.has(tool.toolCallId)) break;

          this.emitEvent({
            type: "tool_end",
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            detail: tool.detail,
            isError: tool.isError,
          });
          this.runningToolParts.delete(tool.toolCallId);
          this.completedToolParts.add(tool.toolCallId);
        }
        break;
      }
      case "message.part.delta": {
        // Cancel any pending idle - main agent may still be processing
        this.cancelIdleTimer();
        if (props.field === "text" && props.delta) {
          this.streamedContent = true;
          this.emitEvent({ type: "stream_delta", delta: props.delta });
        } else if (props.field === "thinking" && props.delta) {
          this.streamedContent = true;
          this.emitEvent({ type: "thinking_delta", delta: props.delta });
        }
        break;
      }
      case "session.status": {
        const statusType = props.status?.type || props.status;
        if (statusType === "busy") {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            title: "OpenCode 正在处理",
            state: "running",
          });
          // Session is busy - cancel any pending idle timer (sub-agent done but main agent continues)
          this.cancelIdleTimer();
        } else if (statusType === "idle") {
          this.emitEvent({
            type: "process_event",
            entryType: "status",
            title: "OpenCode 处理完成",
            state: "completed",
          });
          // Session is truly idle - schedule stream end with a small delay
          // to catch any trailing message.part.delta events
          this.scheduleIdleEnd();
        }
        break;
      }
      case "session.error": {
        this.cancelIdleTimer();
        const err = props.error;
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          title: "OpenCode 错误",
          detail: err?.data?.message || err?.message || "OpenCode request failed",
          state: "error",
        });
        const msg = err?.data?.message || err?.message || "未知错误";
        this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${msg}` });
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
      const messages = (await this.httpGet(`/session/${this.sessionId}/message`)) as any[];
      if (Array.isArray(messages)) {
        // Find the last assistant message
        const assistantMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant");
        if (assistantMsg && assistantMsg.parts && assistantMsg.parts.length > 0) {
          for (const part of assistantMsg.parts) {
            if (part.type === "text" && part.text) {
              this.emitEvent({ type: "stream_delta", delta: part.text });
            } else if (part.type === "thinking" && part.text) {
              this.emitEvent({ type: "thinking_delta", delta: part.text });
            }
          }
        } else if (assistantMsg?.info?.error) {
          // Message completed with error
          const errMsg = assistantMsg.info.error.data?.message || assistantMsg.info.error.message || "请求失败";
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
  }

  /** Get available models from providers */
  async getModels(): Promise<AgentModel[]> {
    console.log("[opencode] getModels called, cached:", this.models.length, "port:", this.port);
    if (this.models.length > 0) return this.models;

    try {
      const result = (await this.httpGet("/config/providers")) as any;
      if (result && result.providers) {
        const models: AgentModel[] = [];
        for (const provider of result.providers) {
          const providerId = provider.id || provider.name;
          if (Array.isArray(provider.models)) {
            for (const m of provider.models) {
              models.push({
                id: m.id || m.name,
                name: m.name || m.id,
                provider: providerId,
                reasoning: m.reasoning ?? false,
              });
            }
          } else if (provider.models && typeof provider.models === "object") {
            // models may be a record: { modelId: modelInfo }
            for (const [modelId, modelInfo] of Object.entries(provider.models as Record<string, any>)) {
              models.push({
                id: modelId,
                name: modelInfo?.name || modelId,
                provider: providerId,
                reasoning: modelInfo?.reasoning ?? false,
              });
            }
          } else if (result.default?.[providerId]) {
            models.push({
              id: result.default[providerId],
              name: result.default[providerId],
              provider: providerId,
              reasoning: false,
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

  /** For OpenCode, the session ID serves as the session file path equivalent */
  get sessionFilePath(): string | null { return this.sessionId; }

  /** Dispose and clean up */
  dispose() {
    this.cancelIdleTimer();
    this.stopSSEListener();
    this.killProcess();
  }

  private killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.sessionId = null;
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

  private httpPatch(path: string, data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const req = http.request(
        `http://${this.host}:${this.port}${path}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 10000,
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
    this.window?.webContents.send("agent:event", data);
  }
}
