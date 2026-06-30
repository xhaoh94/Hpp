import { ipcMain, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { OpenCodeAgent } from "./opencode-agent";
import { DroidAgent } from "./droid-agent";
import { AgentEventBuffer } from "./agent-event-buffer";
import { PiSDKAgent } from "./pi-sdk-agent";
import {
  buildDiffsFromToolEvent,
  normalizeQuestionProcessEvent,
  normalizeToolEvent,
} from "./process-events";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

/** Common interface for all agent backends */
interface AgentBackend {
  setWindow(win: BrowserWindow): void;
  init(projectPath: string, existingSessionFilePath?: string): Promise<void>;
  sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>): Promise<void>;
  abort(): Promise<void>;
  getModels(): Promise<AgentModel[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  sendUIResponse(response: any): void;
  dispose(): void;
  readonly sessionFilePath: string | null;
}

// ============================================================
// Pi Agent - one process per session for full context preservation
// ============================================================
class PiAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private hppSessionId: string;
  private models: AgentModel[] = [];
  private pendingResponses = new Map<string, (data: any) => void>();
  private rpcId = 0;
  private isMock = true;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private turnFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private abortResponseTimer: ReturnType<typeof setTimeout> | null = null;
  private processGeneration = 0;
  private isAborting = false;
  private streamedText = false;
  private pendingAssistantText = "";
  private pendingUIRequestIds = new Set<string>();
  private eventBuffer: AgentEventBuffer;

  constructor(hppSessionId = "default") {
    this.hppSessionId = hppSessionId;
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
    this.eventBuffer.setWindow(win);
  }

  /** Start a new pi process for this session */
  async init(projectPath: string, existingSessionFilePath?: string): Promise<void> {
    // If already running for same project, don't restart
    if (this.process && this.projectPath === projectPath) return;

    this.projectPath = projectPath;
    this.killProcess();
    this.isMock = true;
    this._sessionFilePath = existingSessionFilePath || null;
    this.emitEvent({ type: "agent_init", agentId: "pi" });

    const args = ["--mode", "rpc"];
    if (existingSessionFilePath) {
      args.push("--session", existingSessionFilePath);
    }

    const generation = ++this.processGeneration;
    const child = spawn("pi", args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
    this.process = child;

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let initResolved = false;

    child.on("exit", () => {
      if (generation !== this.processGeneration) return;
      if (this.process === child) this.process = null;
      if (this.isAborting) {
        this.finishAbortState();
        return;
      }
      if (!initResolved) {
        initResolved = true;
        this.isMock = true;
        this.emitEvent({ type: "agent_ready", agentId: "pi", mock: true });
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (generation !== this.processGeneration) return;
      buffer += decoder.write(chunk);
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) {
          try {
            const data = JSON.parse(line);
            this.handleMessage(data);
            if (!initResolved && data.type === "response" && data.command === "get_state") {
              initResolved = true;
              this.isMock = false;
              if (data.data?.sessionFile) {
                this._sessionFilePath = data.data.sessionFile;
              }
              this.emitEvent({ type: "agent_ready", agentId: "pi", mock: false });
            }
          } catch { /* skip */ }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (generation !== this.processGeneration) return;
      console.log("[pi]", chunk.toString().trim());
    });

    // Wait for init
    await new Promise<void>((resolve) => {
      this.sendCommand({ type: "get_state" });
      const check = setInterval(() => {
        if (initResolved) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        if (!initResolved) {
          initResolved = true;
          this.isMock = true;
          this.killProcess();
          this.emitEvent({ type: "agent_ready", agentId: "pi", mock: true });
        }
        resolve();
      }, 8000);
    });
  }

  /** Switch to an existing session file (for resuming after restart) */
  async switchToSession(sessionFilePath: string): Promise<boolean> {
    if (this.isMock || !this.process) return false;
    return new Promise<boolean>((resolve) => {
      this.sendCommand({ type: "switch_session", sessionPath: sessionFilePath }, (data) => {
        if (data.success && !data.data?.cancelled) {
          this._sessionFilePath = sessionFilePath;
          resolve(true);
        } else {
          resolve(false);
        }
      });
      setTimeout(() => resolve(false), 5000);
    });
  }

  get sessionFilePath(): string | null { return this._sessionFilePath; }

  sendUIResponse(response: any) {
    if (this.isMock || !this.process) return;
    if (response?.id) {
      this.pendingUIRequestIds.delete(response.id);
      if (this.pendingUIRequestIds.size === 0 && (this.pendingAssistantText || this.streamedText)) {
        this.scheduleTurnFallback(4000);
      }
    }
    const line = JSON.stringify(response) + "\n";
    this.process.stdin?.write(line);
  }

  private killProcess() {
    const proc = this.process;
    this.processGeneration += 1;
    this.process = null;
    this.isAborting = false;
    if (proc) {
      proc.stdin?.destroy();
      proc.kill();
    }
    this.pendingResponses.clear();
    this.pendingUIRequestIds.clear();
    this.eventBuffer.flush();
    this.clearTurnFallback();
    this.clearAbortResponseTimer();
  }

  async sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>): Promise<void> {
    if (this.isAborting) {
      this.finishAbortState();
    }
    if (this.isMock || !this.process) {
      this.mockResponse(message);
      return;
    }
    this.emitEvent({ type: "message_start", role: "user", content: message });
    const cmd: any = { type: "prompt", message };
    if (images && images.length > 0) {
      cmd.images = images;
    }
    this.sendCommand(cmd);
  }

  private async mockResponse(message: string) {
    this.emitEvent({ type: "message_start", role: "user", content: message });
    this.emitEvent({ type: "stream_start", role: "assistant" });
    const response = `收到消息: "${message}"\n\n这是离线模拟回复。如需使用真实 Agent，请安装 \`pi\` CLI 并配置 API key。`;
    for (let i = 0; i < response.length; i += 4) {
      await new Promise((r) => setTimeout(r, 8));
      this.emitEvent({ type: "stream_delta", delta: response.slice(i, i + 4) });
    }
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
  }

  async abort() {
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.eventBuffer.clear();
    this.clearTurnFallback();
    this.emitEvent({ type: "thinking_end" });
    this.emitEvent({ type: "stream_end", content: "" });
    this.emitEvent({ type: "agent_end" });

    if (this.isMock || !this.process) {
      this.finishAbortState();
      return;
    }

    this.isAborting = true;
    let abortCommandId: string | null = null;

    try {
      abortCommandId = this.sendCommand({ type: "abort" }, () => {
        this.finishAbortState();
      });
    } catch {
      this.finishAbortState();
      return;
    }

    this.clearAbortResponseTimer();
    this.abortResponseTimer = setTimeout(() => {
      this.abortResponseTimer = null;
      if (abortCommandId) this.pendingResponses.delete(abortCommandId);
    }, 10000);
  }

  async getModels(): Promise<AgentModel[]> {
    if (this.models.length > 0) return this.models;
    try {
      const rpcModels = await new Promise<AgentModel[]>((resolve) => {
        this.sendCommand({ type: "get_available_models" }, (data) => {
          const models: AgentModel[] = [];
          if (data.success && data.data?.models) {
            models.push(...data.data.models.map((m: any) => ({
              id: m.id, name: m.name || m.id, provider: m.provider, reasoning: m.reasoning ?? false,
            })));
          }
          resolve(models);
        });
        setTimeout(() => resolve([]), 3000);
      });
      if (rpcModels.length > 0) { this.models = rpcModels; return this.models; }
    } catch { /* ignore */ }
    return this.models;
  }

  async setModel(provider: string, modelId: string) {
    this.sendCommand({ type: "set_model", provider, modelId }, (data) => {
      if (data.success) this.emitEvent({ type: "model_changed", model: { id: modelId, provider } });
    });
  }

  async setThinkingLevel(level: string) {
    this.sendCommand({ type: "set_thinking_level", level }, (data) => {
      if (data.success) this.emitEvent({ type: "thinking_level_changed", level });
    });
  }

  dispose() { this.killProcess(); }

  private handleMessage(data: any) {
    if (data.type === "response" && data.id) {
      const handler = this.pendingResponses.get(data.id);
      if (handler) { handler(data); this.pendingResponses.delete(data.id); }
    }

    if (this.isAborting) {
      if (data.type === "agent_end" || data.type === "message_end") {
        this.finishAbortState();
      }
      return;
    }

    switch (data.type) {
      case "agent_start":
        this.clearTurnFallback();
        this.streamedText = false;
        this.pendingAssistantText = "";
        this.emitEvent({ type: "stream_start", role: "assistant" });
        break;
      case "message_update": {
        this.clearTurnFallback();
        const aev = data.assistantMessageEvent;
        if (aev) {
          if (aev.type === "text_delta") {
            if (aev.delta) this.streamedText = true;
            this.emitEventThrottled({ type: "stream_delta", delta: aev.delta });
          }
          else if (aev.type === "thinking_delta") this.emitEventThrottled({ type: "thinking_delta", delta: aev.delta });
        }
        break;
      }
      case "message_end":
        if (data.message?.role === "assistant") {
          const content = data.message.content || [];
          const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          const thinkingParts = content.filter((c: any) => c.type === "thinking").map((c: any) => c.text || c.thinking || "").join("");
          if (thinkingParts) {
            this.emitEvent({ type: "thinking_end" });
          }
          if (textParts) {
            this.pendingAssistantText = textParts;
            this.scheduleTurnFallback(4000);
          }
        }
        break;
      case "user_ask_question":
      case "ask_user_question":
      case "ask_user":
        this.emitEvent(normalizeQuestionProcessEvent(data));
        break;
      case "extension_ui_request":
        if (data.id && data.method !== "notify" && data.method !== "setStatus" && data.method !== "setWidget" && data.method !== "setTitle" && data.method !== "set_editor_text") {
          this.pendingUIRequestIds.add(String(data.id));
          this.clearTurnFallback();
          this.emitEvent(normalizeQuestionProcessEvent(data));
        }
        break;
      case "agent_end":
        this.completeTurn();
        break;
      case "tool_execution_start":
        this.clearTurnFallback();
        this.emitEvent(normalizeToolEvent("tool_start", { ...data, args: this.getToolArgs(data) }));
        break;
      case "tool_execution_end":
        {
          const toolEvent = normalizeToolEvent("tool_end", { ...data, args: this.getToolArgs(data) });
          this.emitEvent(toolEvent);
          const diffs = buildDiffsFromToolEvent(toolEvent);
          if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        }
        break;
    }
  }

  private getToolArgs(data: any) {
    return data.args || data.input || data.parameters || data.toolInput || data.tool_input || data.arguments;
  }

  private clearTurnFallback() {
    if (this.turnFallbackTimer) {
      clearTimeout(this.turnFallbackTimer);
      this.turnFallbackTimer = null;
    }
  }

  private clearAbortResponseTimer() {
    if (this.abortResponseTimer) {
      clearTimeout(this.abortResponseTimer);
      this.abortResponseTimer = null;
    }
  }

  private finishAbortState() {
    this.isAborting = false;
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.eventBuffer.clear();
    this.clearTurnFallback();
    this.clearAbortResponseTimer();
  }

  private scheduleTurnFallback(delayMs: number) {
    if (this.pendingUIRequestIds.size > 0) return;
    this.clearTurnFallback();
    this.turnFallbackTimer = setTimeout(() => {
      this.turnFallbackTimer = null;
      if (this.pendingAssistantText || this.streamedText) {
        this.completeTurn();
      }
    }, delayMs);
  }

  private flushQueuedEvents() {
    this.eventBuffer.flush();
  }

  private completeTurn() {
    this.clearTurnFallback();
    this.flushQueuedEvents();
    if (!this.streamedText && this.pendingAssistantText) {
      this.emitEvent({ type: "stream_delta", delta: this.pendingAssistantText });
      this.streamedText = true;
    }
    this.emitEvent({ type: "stream_end", content: this.pendingAssistantText });
    this.emitEvent({ type: "agent_end" });
    this.pendingAssistantText = "";
    this.streamedText = false;
  }

  private sendCommand(cmd: any, onResponse?: (data: any) => void): string {
    const id = `rpc-${++this.rpcId}`;
    const fullCmd = { ...cmd, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(JSON.stringify(fullCmd) + "\n");
    return id;
  }

  private withSessionId(data: { type: string; [key: string]: unknown }) {
    return { ...data, sessionId: this.hppSessionId };
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  /** Emit event with throttle for streaming events to prevent React batching */
  private emitEventThrottled(data: { type: string; [key: string]: unknown }) {
    this.eventBuffer.send(data);
  }
}

// ============================================================
// Agent Manager - supports PiAgent and OpenCodeAgent per session
// ============================================================
class AgentManager {
  private sessionAgents = new Map<string, AgentBackend>();
  private sessionAgentTypes = new Map<string, string>(); // sessionId -> agentId ("pi" | "opencode")
  private sessionFilePaths = new Map<string, string>();
  private activeSessionId: string | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) { this.window = win; }

  private createAgentBackend(agentId: string, sessionId: string): AgentBackend {
    if (agentId === "opencode") return new OpenCodeAgent(sessionId);
    if (agentId === "droid") return new DroidAgent(sessionId);
    return new PiSDKAgent(sessionId); // default
  }

  /** Create or resume a session */
  async createSession(
    sessionId: string, agentId: string, projectPath: string,
    existingSessionFilePath?: string
  ): Promise<void> {
    console.log("[agent-manager] createSession:", sessionId, "agent:", agentId, "existingSessionFilePath:", existingSessionFilePath);
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = this.createAgentBackend(agentId, sessionId);
      this.sessionAgents.set(sessionId, agent);
      this.sessionAgentTypes.set(sessionId, agentId);
      console.log("[agent-manager] Created new agent:", agent.constructor.name);
    } else {
      console.log("[agent-manager] Reusing existing agent:", agent.constructor.name);
    }
    if (this.window) agent.setWindow(this.window);
    await agent.init(projectPath, existingSessionFilePath);

    const fp = agent.sessionFilePath;
    console.log("[agent-manager] After init, sessionFilePath:", fp);
    if (fp) this.sessionFilePaths.set(sessionId, fp);

    this.activeSessionId = sessionId;
  }

  getSessionFilePath(sessionId: string): string | undefined {
    return this.sessionFilePaths.get(sessionId);
  }

  switchSession(sessionId: string) {
    if (this.sessionAgents.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }

  getActiveAgent(): AgentBackend | null {
    if (!this.activeSessionId) return null;
    return this.sessionAgents.get(this.activeSessionId) || null;
  }
  getAgentBySessionId(sessionId: string): AgentBackend | null {
    return this.sessionAgents.get(sessionId) || null;
  }

  async getModelsBySessionId(sessionId: string): Promise<AgentModel[]> {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return [];
    return agent.getModels();
  }

  sendUIResponse(response: any) {
    const agent = response?.sessionId
      ? this.getAgentBySessionId(response.sessionId)
      : this.getActiveAgent();
    if (!agent) return;
    agent.sendUIResponse(response);
  }

  removeSession(sessionId: string) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) { agent.dispose(); this.sessionAgents.delete(sessionId); }
    this.sessionAgentTypes.delete(sessionId);
    this.sessionFilePaths.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }
}

const agentManager = new AgentManager();

// ============================================================
// IPC handlers
// ============================================================
export function registerAgentHandlers(getWindow: () => BrowserWindow | null) {
  ipcMain.handle("agent:createSession", async (_event, agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) => {
    const sid = sessionId || "default";
    try {
      const win = getWindow();
      if (win) agentManager.setWindow(win);
      await agentManager.createSession(sid, agentId, projectPath, sessionFilePath);
      const models = await agentManager.getModelsBySessionId(sid);
      return { success: true, sessionFilePath: agentManager.getSessionFilePath(sid), models };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("agent:switchSession", async (_event, sessionId: string) => {
    agentManager.switchSession(sessionId);
    return { success: true };
  });

  ipcMain.handle("agent:removeSession", async (_event, sessionId: string) => {
    agentManager.removeSession(sessionId);
    return { success: true };
  });

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      await agent.sendMessage(message, images);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("agent:abort", async (_event, sessionId?: string) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.abort();
    return { success: true };
  });

  ipcMain.handle("agent:getModels", async (_event, sessionId?: string) => {
    const agent = sessionId
      ? agentManager.getAgentBySessionId(sessionId)
      : agentManager.getActiveAgent();
    console.log("[agent-manager] getModels sessionId:", sessionId, "agent:", agent ? agent.constructor.name : "null");
    if (!agent) return [];
    return agent.getModels();
  });

  ipcMain.handle("agent:setModel", async (_event, provider: string, modelId: string) => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.setModel(provider, modelId);
    return { success: true };
  });

  ipcMain.handle("agent:setThinkingLevel", async (_event, level: string) => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.setThinkingLevel(level);
    return { success: true };
  });

  ipcMain.handle("agent:sendUIResponse", async (_event, response: any) => {
    agentManager.sendUIResponse(response);
    return { success: true };
  });
}
