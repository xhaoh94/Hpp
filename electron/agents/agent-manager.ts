import { ipcMain, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { readFile } from "fs/promises";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

// ============================================================
// Pi Agent - one process per session for full context preservation
// ============================================================
class PiAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private models: AgentModel[] = [];
  private pendingResponses = new Map<string, (data: any) => void>();
  private rpcId = 0;
  private isMock = true;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventQueue: Array<{ type: string; data: unknown }> = [];
  private eventTimer: ReturnType<typeof setTimeout> | null = null;

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  /** Start a new pi process for this session */
  async init(projectPath: string, existingSessionFilePath?: string): Promise<void> {
    // If already running for same project, don't restart
    if (this.process && this.projectPath === projectPath) return;

    this.projectPath = projectPath;
    this.killProcess();
    this.isMock = true;
    this._sessionFilePath = null;
    this.emitEvent({ type: "agent_init", agentId: "pi" });

    const args = ["--mode", "rpc"];
    if (existingSessionFilePath) {
      args.push("--session", existingSessionFilePath);
    }

    this.process = spawn("pi", args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let initResolved = false;

    this.process.on("exit", () => {
      if (!initResolved) {
        initResolved = true;
        this.isMock = true;
        this.process = null;
        this.emitEvent({ type: "agent_ready", agentId: "pi", mock: true });
      }
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
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

    this.process.stderr?.on("data", (chunk: Buffer) => {
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

  private killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.pendingResponses.clear();
    this.eventQueue = [];
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
  }

  async sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>): Promise<void> {
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

  async abort() { this.sendCommand({ type: "abort" }); }

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
    try {
      const { join } = await import("path");
      const { homedir } = await import("os");
      const configPath = join(homedir(), ".pi/agent/models.json");
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      const models: AgentModel[] = [];
      if (config.providers) {
        for (const [provider, pc] of Object.entries(config.providers as any)) {
          if (Array.isArray(pc.models)) {
            for (const m of pc.models) {
              models.push({ id: m.id || m.name, name: m.name || m.id, provider, reasoning: m.reasoning ?? false });
            }
          }
        }
      }
      if (models.length > 0) { this.models = models; return this.models; }
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
    switch (data.type) {
      case "agent_start":
        this.emitEvent({ type: "stream_start", role: "assistant" });
        break;
      case "message_update": {
        const aev = data.assistantMessageEvent;
        if (aev) {
          if (aev.type === "text_delta") this.emitEventThrottled({ type: "stream_delta", delta: aev.delta });
          else if (aev.type === "thinking_delta") this.emitEventThrottled({ type: "thinking_delta", delta: aev.delta });
        }
        break;
      }
      case "message_end":
        if (data.message?.role === "assistant") {
          const textParts = (data.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          // Flush any remaining queued streaming events before sending stream_end
          while (this.eventQueue.length > 0) {
            const item = this.eventQueue.shift()!;
            this.window?.webContents.send("agent:event", item);
          }
          if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
          this.emitEvent({ type: "stream_end", content: textParts });
        }
        break;
      case "agent_end":
        // Flush any remaining queued events before sending agent_end
        while (this.eventQueue.length > 0) {
          const item = this.eventQueue.shift()!;
          this.window?.webContents.send("agent:event", item);
        }
        if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = null; }
        this.emitEvent({ type: "agent_end" });
        break;
      case "tool_execution_start":
        this.emitEvent({ type: "tool_start", toolName: data.toolName, toolCallId: data.toolCallId });
        break;
      case "tool_execution_end":
        this.emitEvent({ type: "tool_end", toolName: data.toolName, toolCallId: data.toolCallId, isError: data.isError });
        break;
    }
  }

  private sendCommand(cmd: any, onResponse?: (data: any) => void): string {
    const id = `rpc-${++this.rpcId}`;
    const fullCmd = { ...cmd, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(JSON.stringify(fullCmd) + "\n");
    return id;
  }

  private emitEvent(data: unknown) {
    this.window?.webContents.send("agent:event", data);
  }

  /** Emit event with throttle for streaming events to prevent React batching */
  private emitEventThrottled(data: { type: string; [key: string]: unknown }) {
    const streamingTypes = new Set(["stream_delta"]);
    if (streamingTypes.has(data.type)) {
      this.eventQueue.push(data);
      this.flushEventQueue();
    } else {
      // Non-streaming and thinking_delta events go through immediately
      this.window?.webContents.send("agent:event", data);
    }
  }

  private flushEventQueue() {
    if (this.eventTimer) return; // Already scheduled
    if (this.eventQueue.length === 0) return;
    const item = this.eventQueue.shift()!;
    this.window?.webContents.send("agent:event", item);
    if (this.eventQueue.length > 0) {
      this.eventTimer = setTimeout(() => {
        this.eventTimer = null;
        this.flushEventQueue();
      }, 5); // 5ms delay between streaming events
    }
  }
}

// ============================================================
// Agent Manager - one PiAgent per session for context preservation
// ============================================================
class AgentManager {
  private sessionAgents = new Map<string, PiAgent>(); // sessionId -> PiAgent
  private sessionFilePaths = new Map<string, string>(); // sessionId -> sessionFile path
  private activeSessionId: string | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) { this.window = win; }

  /** Create or resume a session. If existingSessionFilePath is given, switch to it after init. */
  async createSession(
    sessionId: string, agentId: string, projectPath: string,
    existingSessionFilePath?: string
  ): Promise<void> {
    let agent = this.sessionAgents.get(sessionId);
    if (!agent) {
      agent = new PiAgent();
      this.sessionAgents.set(sessionId, agent);
    }
    if (this.window) agent.setWindow(this.window);
    await agent.init(projectPath, existingSessionFilePath);

    // Store the session file path
    const fp = agent.sessionFilePath;
    if (fp) this.sessionFilePaths.set(sessionId, fp);

    this.activeSessionId = sessionId;
  }

  /** Get stored session file path for a session */
  getSessionFilePath(sessionId: string): string | undefined {
    return this.sessionFilePaths.get(sessionId);
  }

  /** Switch active session */
  switchSession(sessionId: string) {
    if (this.sessionAgents.has(sessionId)) {
      this.activeSessionId = sessionId;
    }
  }

  /** Get the active agent */
  getActiveAgent(): PiAgent | null {
    if (!this.activeSessionId) return null;
    return this.sessionAgents.get(this.activeSessionId) || null;
  }

  /** Remove a session's agent */
  removeSession(sessionId: string) {
    const agent = this.sessionAgents.get(sessionId);
    if (agent) { agent.dispose(); this.sessionAgents.delete(sessionId); }
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
      return { success: true, sessionFilePath: agentManager.getSessionFilePath(sid) };
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

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: Array<{ type: string; data: string; mimeType: string }>) => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      await agent.sendMessage(message, images);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("agent:abort", async () => {
    const agent = agentManager.getActiveAgent();
    if (!agent) return { success: false };
    await agent.abort();
    return { success: true };
  });

  ipcMain.handle("agent:getModels", async () => {
    const agent = agentManager.getActiveAgent();
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
}
