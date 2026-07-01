import { BrowserWindow, app } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { AgentEventBuffer } from "./agent-event-buffer";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

const getWorkerPath = () => {
  const candidates = [
    join(__dirname, "codex-sdk-worker.mjs"),
    join(app.getAppPath(), "electron", "agents", "codex-sdk-worker.mjs"),
    join(process.cwd(), "electron", "agents", "codex-sdk-worker.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1];
};

const getNodeExecutable = () => {
  if (process.env.CODEX_NODE_PATH) return process.env.CODEX_NODE_PATH;
  if (process.env.PI_NODE_PATH) return process.env.PI_NODE_PATH;
  return process.platform === "win32" ? "node.exe" : "node";
};

export class CodexSDKAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventBuffer: AgentEventBuffer;
  private pendingResponses = new Map<string, (data: any) => void>();
  private requestId = 0;
  private models: AgentModel[] = [];
  private isAborting = false;

  constructor(private readonly hppSessionId = "default") {
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }

  get sessionFilePath(): string | null {
    return this._sessionFilePath;
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
    this.eventBuffer.setWindow(win);
  }

  async init(projectPath: string, existingSessionFilePath?: string): Promise<void> {
    if (this.process && this.projectPath === projectPath && this._sessionFilePath === (existingSessionFilePath || this._sessionFilePath)) {
      return;
    }

    this.dispose();
    this.projectPath = projectPath;
    this._sessionFilePath = existingSessionFilePath || null;
    this.emitEvent({ type: "agent_init", agentId: "codex" });

    const child = spawn(getNodeExecutable(), [getWorkerPath()], {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;

    const decoder = new StringDecoder("utf8");
    let buffer = "";
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
      console.log("[codex-sdk-worker]", chunk.toString().trim());
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
    });

    child.on("exit", () => {
      if (this.process === child) this.process = null;
      if (!this.isAborting) {
        this.emitEvent({ type: "agent_disconnected" });
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(initId);
        reject(new Error("Codex SDK worker init timed out"));
      }, 12000);
      const initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: existingSessionFilePath,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "ready") {
          this._sessionFilePath = data.sessionFilePath || existingSessionFilePath || null;
          this.emitEvent({ type: "agent_ready", agentId: "codex", mock: false });
          resolve();
        } else {
          reject(new Error(data.error || "Codex SDK worker init failed"));
        }
      });
    });
  }

  async sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>): Promise<void> {
    if (!this.process) throw new Error("Codex SDK worker is not running");
    this.isAborting = false;
    const promptId = this.createCommandId();
    this.emitEvent({ type: "message_start", role: "user", content: message });
    this.sendWorkerCommand({ id: promptId, type: "prompt", message, images });
  }

  async abort(): Promise<void> {
    this.isAborting = true;
    this.eventBuffer.clear();
    if (!this.process) {
      this.isAborting = false;
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      this.sendWorkerCommand({ type: "abort" }, () => {
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
        this.models = Array.isArray(data.models) ? data.models : [];
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

  sendUIResponse(response: any): void {
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id: response?.id,
        value: response?.value ?? response?.text,
        confirmed: response?.confirmed,
        cancelled: !!response?.cancelled,
        result: response?.result ?? (response?.answers ? { cancelled: false, answers: response.answers } : undefined),
      },
    });
  }

  dispose(): void {
    this.pendingResponses.clear();
    this.eventBuffer.flush();
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin?.write(`${JSON.stringify({ type: "dispose" })}\n`);
      setTimeout(() => child.kill(), 500);
    }
  }

  private handleWorkerMessage(data: any) {
    if (data.id) {
      const handler = this.pendingResponses.get(data.id);
      if (handler) {
        this.pendingResponses.delete(data.id);
        handler(data);
      }
    }

    switch (data.type) {
      case "ready":
        for (const handler of this.pendingResponses.values()) handler(data);
        this.pendingResponses.clear();
        break;
      case "session_file_path":
        this._sessionFilePath = data.sessionFilePath || data.threadId || this._sessionFilePath;
        this.emitEvent({ type: "session_file_path", sessionFilePath: this._sessionFilePath, threadId: data.threadId });
        break;
      case "agent_start":
        this.emitEvent({ type: "agent_start" });
        break;
      case "stream_start":
        this.emitEvent({ type: "stream_start", role: data.role || "assistant" });
        break;
      case "stream_delta":
        this.emitEvent({ type: "stream_delta", delta: data.delta || "" });
        break;
      case "stream_snapshot":
        this.emitEvent({ type: "stream_snapshot", content: data.content || "" });
        break;
      case "stream_end":
        this.emitEvent({ type: "stream_end", content: data.content || "", force: data.force });
        break;
      case "thinking_delta":
        this.emitEvent({ type: "thinking_delta", delta: data.delta || "" });
        break;
      case "thinking_end":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "tool_start":
      case "tool_end":
      case "process_event":
      case "diff_update":
      case "agent_end":
        this.emitEvent(data);
        break;
      case "prompt_done":
        break;
      case "error":
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Codex 运行失败",
          detail: data.error || "Unknown error",
          state: "error",
        });
        break;
    }
  }

  private sendWorkerCommand(command: any, onResponse?: (data: any) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}\n`);
    return id;
  }

  private createCommandId(): string {
    return `codex-${++this.requestId}`;
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }
}
