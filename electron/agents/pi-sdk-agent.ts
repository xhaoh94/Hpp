import { BrowserWindow, app } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { AgentEventBuffer } from "./agent-event-buffer";
import { buildDiffsFromToolEvent, normalizeQuestionProcessEvent, normalizeToolEvent, unwrapToolText } from "./process-events";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

const getWorkerPath = () => {
  const candidates = [
    join(__dirname, "pi-sdk-worker.mjs"),
    join(app.getAppPath(), "electron", "agents", "pi-sdk-worker.mjs"),
    join(process.cwd(), "electron", "agents", "pi-sdk-worker.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1];
};

const getNodeExecutable = () => {
  if (process.env.PI_NODE_PATH) return process.env.PI_NODE_PATH;
  return process.platform === "win32" ? "node.exe" : "node";
};

export class PiSDKAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  private eventBuffer: AgentEventBuffer;
  private pendingResponses = new Map<string, (data: any) => void>();
  private requestId = 0;
  private models: AgentModel[] = [];
  private pendingAssistantText = "";
  private streamedText = false;
  private pendingUIRequestIds = new Set<string>();
  private turnFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private isAborting = false;
  private activePromptIds = new Set<string>();
  private turnActive = false;
  private turnToken = 0;

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
    this.emitEvent({ type: "agent_init", agentId: "pi" });

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
      console.log("[pi-sdk-worker]", chunk.toString().trim());
    });

    child.on("error", (error) => {
      this.emitEvent({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "Pi 启动失败",
        detail: `${error.message}\n请确认系统 PATH 中的 node 版本 >= 22，或设置 PI_NODE_PATH 指向 Node 22。`,
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
        reject(new Error("Pi SDK worker init timed out"));
      }, 12000);
      const initId = this.sendWorkerCommand({
        type: "init",
        projectPath,
        sessionFilePath: existingSessionFilePath,
      }, (data) => {
        clearTimeout(timeout);
        if (data.type === "ready") {
          this._sessionFilePath = data.sessionFilePath || existingSessionFilePath || null;
          this.emitEvent({ type: "agent_ready", agentId: "pi", mock: false });
          resolve();
        } else {
          reject(new Error(data.error || "Pi SDK worker init failed"));
        }
      });
    });
  }

  async sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>): Promise<void> {
    if (!this.process) throw new Error("Pi SDK worker is not running");
    if (this.isAborting) this.finishAbortState();

    if (this.turnActive) {
      this.completeTurn(true);
    } else {
      this.prepareNewTurn();
    }

    const promptId = this.createCommandId();
    this.activePromptIds.add(promptId);
    this.emitEvent({ type: "message_start", role: "user", content: message });
    this.beginTurn();
    this.sendWorkerCommand({ id: promptId, type: "prompt", message, images });
  }

  async abort(): Promise<void> {
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.eventBuffer.clear();
    this.clearTurnFallback();
    this.emitEvent({ type: "thinking_end" });
    this.emitEvent({ type: "stream_end", content: "" });
    this.emitEvent({ type: "agent_end" });
    this.isAborting = true;

    if (!this.process) {
      this.finishAbortState();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      this.sendWorkerCommand({ type: "abort" }, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.finishAbortState();
  }

  async getModels(): Promise<AgentModel[]> {
    if (this.models.length > 0) return this.models;
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
    const id = response?.id;
    if (id) {
      this.pendingUIRequestIds.delete(String(id));
      if (this.pendingUIRequestIds.size === 0 && (this.pendingAssistantText || this.streamedText)) {
        this.scheduleTurnFallback(4000);
      }
    }
    this.sendWorkerCommand({
      type: "uiResponse",
      response: {
        id,
        value: response?.value ?? response?.text,
        confirmed: response?.confirmed,
        cancelled: !!response?.cancelled,
        result: response?.result ?? (response?.answers ? { cancelled: false, answers: response.answers } : undefined),
      },
    });
  }

  dispose(): void {
    this.clearTurnFallback();
    this.pendingResponses.clear();
    this.pendingUIRequestIds.clear();
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
      case "agent_start":
        this.beginTurn();
        break;
      case "message_update": {
        if (!this.turnActive && this.activePromptIds.size > 0) this.beginTurn();
        if (!this.turnActive) break;
        this.clearTurnFallback();
        const assistantEvent = data.assistantMessageEvent;
        if (assistantEvent?.type === "text_delta") {
          if (assistantEvent.delta) this.streamedText = true;
          this.emitEventThrottled({ type: "stream_delta", delta: assistantEvent.delta || "" });
        } else if (assistantEvent?.type === "thinking_delta") {
          this.emitEventThrottled({ type: "thinking_delta", delta: assistantEvent.delta || "" });
        }
        break;
      }
      case "message_end":
        if (!this.turnActive && this.activePromptIds.size === 0) break;
        if (!this.turnActive) this.beginTurn();
        if (data.message?.role === "assistant") {
          if (data.message.thinking) this.emitEvent({ type: "thinking_end" });
          if (data.message.text) {
            this.pendingAssistantText = data.message.text;
            this.scheduleTurnFallback(4000, true);
          }
        }
        break;
      case "tool_execution_start":
        this.clearTurnFallback();
        this.emitEvent(normalizeToolEvent("tool_start", { ...data, args: data.args, name: data.toolName }));
        break;
      case "tool_execution_update": {
        const detail = unwrapToolText(data.partialResult);
        if (detail) {
          this.emitEvent(normalizeToolEvent("tool_start", {
            ...data,
            args: data.args,
            result: data.partialResult,
            detail,
            name: data.toolName,
          }));
        }
        break;
      }
      case "tool_execution_end": {
        const toolEvent = normalizeToolEvent("tool_end", {
          ...data,
          args: data.args,
          result: data.result,
          output: data.result,
          name: data.toolName,
        });
        this.emitEvent(toolEvent);
        const diffs = buildDiffsFromToolEvent(toolEvent);
        if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
        break;
      }
      case "extension_ui_request":
        this.handleUIRequest(data.request);
        break;
      case "prompt_done":
        if (data.id && !this.activePromptIds.delete(String(data.id))) break;
        if (!data.id) this.activePromptIds.clear();
        this.pendingUIRequestIds.clear();
        this.completeTurn(true);
        break;
      case "agent_end":
        if (this.activePromptIds.size === 0) this.scheduleTurnFallback(250, true);
        break;
      case "error":
        if (data.id && !this.activePromptIds.delete(String(data.id))) break;
        this.pendingUIRequestIds.clear();
        this.emitEvent({
          type: "process_event",
          entryType: "error",
          kind: "error",
          title: "Pi 运行失败",
          detail: data.error || "Unknown error",
          state: "error",
        });
        this.completeTurn(true);
        break;
    }
  }

  private handleUIRequest(request: any) {
    if (!request || request.method === "notify") return;
    this.pendingUIRequestIds.add(String(request.id));
    this.clearTurnFallback();
    this.emitEvent(normalizeQuestionProcessEvent({
      type: "extension_ui_request",
      id: request.id,
      requestId: request.id,
      method: request.method === "custom" ? request.kind : request.method,
      title: request.method === "custom" && request.kind === "ask_user_question" ? "请选择答案" : request.title || request.message || "正在询问用户",
      detail: request,
      questions: request.method === "custom" ? request.questions : undefined,
      toolName: request.toolName,
      state: "running",
    }));
  }

  private sendWorkerCommand(command: any, onResponse?: (data: any) => void): string {
    const id = command.id || this.createCommandId();
    const fullCommand = { ...command, id };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(`${JSON.stringify(fullCommand)}\n`);
    return id;
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

  private beginTurn() {
    this.clearTurnFallback();
    if (this.turnActive) return;
    this.turnToken += 1;
    this.turnActive = true;
    this.streamedText = false;
    this.pendingAssistantText = "";
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
    this.eventBuffer.flush();
    if (!this.streamedText && this.pendingAssistantText) {
      this.emitEvent({ type: "stream_delta", delta: this.pendingAssistantText });
      this.streamedText = true;
    }
    this.emitEvent({ type: "stream_end", content: this.pendingAssistantText, force });
    this.emitEvent({ type: "agent_end" });
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.turnActive = false;
    this.turnToken += 1;
  }

  private prepareNewTurn() {
    this.clearTurnFallback();
    this.eventBuffer.flush();
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.turnToken += 1;
  }

  private finishAbortState() {
    this.isAborting = false;
    this.pendingAssistantText = "";
    this.streamedText = false;
    this.pendingUIRequestIds.clear();
    this.activePromptIds.clear();
    this.turnActive = false;
    this.turnToken += 1;
    this.eventBuffer.clear();
    this.clearTurnFallback();
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }

  private emitEventThrottled(data: { type: string; [key: string]: unknown }) {
    this.eventBuffer.send(data);
  }
}
