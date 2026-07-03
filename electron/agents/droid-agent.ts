import { BrowserWindow } from "electron";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { delimiter, dirname, join } from "path";
import { homedir } from "os";
import { AgentEventBuffer } from "./agent-event-buffer";
import {
  buildDiffsFromToolEvent,
  isContextCompactionLike,
  normalizeQuestionProcessEvent,
  normalizeToolEvent,
} from "./process-events";

interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
  permissionMode?: "plan" | "full-access";
}

function getPathEnvValue() {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  return process.env[pathKey] || "";
}

function findOnPath(fileNames: string[]): string | undefined {
  for (const dir of getPathEnvValue().split(delimiter)) {
    if (!dir) continue;
    for (const fileName of fileNames) {
      const candidate = join(dir, fileName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function getNodeExecutable() {
  if (process.env.DROID_NODE_PATH) return process.env.DROID_NODE_PATH;
  if (process.env.PI_NODE_PATH) return process.env.PI_NODE_PATH;
  return process.platform === "win32"
    ? findOnPath(["node.exe"]) || "node.exe"
    : "node";
}

function getNpmDroidShimTarget(shimPath: string): string | undefined {
  const target = join(dirname(shimPath), "node_modules", "droid", "bin", "droid");
  return existsSync(target) ? target : undefined;
}

function isWindowsShellShim(filePath: string): boolean {
  return /\.(?:cmd|bat)$/i.test(filePath);
}

function getDroidExecutable(args: string[]): { command: string; args: string[]; shell?: boolean } {
  if (process.env.DROID_PATH && existsSync(process.env.DROID_PATH)) {
    if (process.platform === "win32" && isWindowsShellShim(process.env.DROID_PATH)) {
      return { command: process.env.DROID_PATH, args, shell: true };
    }
    return { command: process.env.DROID_PATH, args };
  }

  if (process.platform !== "win32") {
    return { command: "droid", args };
  }

  const exe = findOnPath(["droid.exe"]);
  if (exe) return { command: exe, args };

  const npmShim = findOnPath(["droid.cmd", "droid.bat"]);
  const shimTarget = npmShim ? getNpmDroidShimTarget(npmShim) : undefined;
  if (shimTarget) return { command: getNodeExecutable(), args: [shimTarget, ...args] };
  if (npmShim) return { command: npmShim, args, shell: true };

  return { command: "droid.exe", args };
}

// ============================================================
// Factory Droid Agent - JSON-RPC over stdin/stdout
// ============================================================
export class DroidAgent {
  private process: ChildProcess | null = null;
  private window: BrowserWindow | null = null;
  private hppSessionId: string;
  private projectPath = "";
  private sessionId: string | null = null;
  private models: AgentModel[] = [];
  private rpcId = 0;
  private pendingResponses = new Map<string, (data: any) => void>();
  private pendingAskUserRequestId: string | null = null;
  private pendingPermissionRequestId: string | null = null;
  private isReady = false;
  private autonomyLevel: "low" | "medium" | "high" = "high";
  private interactionMode = "auto";
  private planModeEnabled = false;
  private eventBuffer: AgentEventBuffer;

  constructor(hppSessionId = "default") {
    this.hppSessionId = hppSessionId;
    this.eventBuffer = new AgentEventBuffer(hppSessionId);
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
    this.eventBuffer.setWindow(win);
  }

  /** Start droid exec in stream-jsonrpc mode */
  async init(projectPath: string, existingSessionId?: string): Promise<void> {
    if (this.process && this.projectPath === projectPath) return;

    this.projectPath = projectPath;
    this.killProcess();
    this.isReady = false;
    this.emitEvent({ type: "agent_init", agentId: "droid" });

    const args = [
      "exec",
      "--input-format", "stream-jsonrpc",
      "--output-format", "stream-jsonrpc",
      "--auto", this.autonomyLevel,
      "--cwd", projectPath,
    ];

    if (existingSessionId) {
      args.push("--session-id", existingSessionId);
    }

    const executable = getDroidExecutable(args);
    this.process = spawn(executable.command, executable.args, {
      cwd: projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      shell: executable.shell || false,
      env: { ...process.env },
    } satisfies SpawnOptions);

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let initResolved = false;

    this.process.on("exit", () => {
      if (!initResolved) {
        initResolved = true;
        this.process = null;
        this.emitEvent({ type: "agent_ready", agentId: "droid", mock: true });
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
            // Detect session initialization response
            if (!initResolved && data.type === "response" && data.id === "init-1" && data.result) {
              initResolved = true;
              this.isReady = true;
              if (data.result?.sessionId) {
                this.sessionId = data.result.sessionId;
              }
              this.emitEvent({ type: "agent_ready", agentId: "droid", mock: false });
            }
          } catch { /* skip non-JSON lines */ }
        }
      }
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      console.log("[droid]", chunk.toString().trim());
    });

    // Send initialize_session immediately after spawning
    this.sendRpc("droid.initialize_session", {
      machineId: "default",
      cwd: projectPath,
      autonomyLevel: this.autonomyLevel,
      interactionMode: this.interactionMode,
    });

    // Wait for init response
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (initResolved) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => {
        clearInterval(check);
        if (!initResolved) {
          initResolved = true;
          this.isReady = false;
          this.killProcess();
          this.emitEvent({ type: "agent_ready", agentId: "droid", mock: true });
        }
        resolve();
      }, 15000);
    });
  }

  /** Send a user message */
  async sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void> {
    if (!this.process || !this.isReady) {
      this.mockResponse(message);
      return;
    }

    this.emitEvent({ type: "stream_start", role: "assistant" });
    const planModeEnabled = !!options?.planModeEnabled || options?.permissionMode === "plan";
    await this.setPermissionMode(planModeEnabled ? "plan" : "full-access");

    const msgParams: any = { text: message };
    if (images && images.length > 0) {
      msgParams.images = images.map((img) => ({
        type: "image",
        mediaType: img.mimeType,
        data: img.data,
      }));
    }

    this.sendRpc("droid.add_user_message", msgParams);
  }

  private async mockResponse(message: string) {
    this.emitEvent({ type: "stream_start", role: "assistant" });
    const response = `收到消息: "${message}"\n\n这是离线模拟回复。如需使用 Factory Droid，请安装 droid CLI 并设置 FACTORY_API_KEY 环境变量。\n\n安装: curl -fsSL https://app.factory.ai/cli | sh`;
    for (let i = 0; i < response.length; i += 4) {
      await new Promise((r) => setTimeout(r, 8));
      this.emitEvent({ type: "stream_delta", delta: response.slice(i, i + 4) });
    }
    this.emitEvent({ type: "stream_end" });
    this.emitEvent({ type: "agent_end" });
  }

  /** Abort current response */
  async abort() {
    if (this.pendingPermissionRequestId) {
      this.sendRpcResponse(this.pendingPermissionRequestId, { selectedOption: "deny" });
      this.pendingPermissionRequestId = null;
    }
    if (this.pendingAskUserRequestId) {
      this.sendRpcResponse(this.pendingAskUserRequestId, { cancelled: true, answers: [] });
      this.pendingAskUserRequestId = null;
    }
    if (this.process) {
      this.sendRpc("droid.interrupt_session", {});
    }
  }

  /** Get available models - Factory provides a curated set + local custom models */
  async getModels(): Promise<AgentModel[]> {
    if (this.models.length > 0) return this.models;

    // Factory Droid's built-in model list (from docs.factory.ai/models)
    this.models = [
      { id: "claude-opus-4-7", name: "Claude Opus 4", provider: "factory", reasoning: true },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", provider: "factory", reasoning: true },
      { id: "claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6", provider: "factory", reasoning: true },
      { id: "gpt-5-codex", name: "GPT-5 Codex", provider: "factory", reasoning: true },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", provider: "factory", reasoning: true },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "factory", reasoning: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "factory", reasoning: false },
    ];

    // Read custom models from ~/.factory/settings.json
    try {
      const configPath = join(homedir(), ".factory", "settings.json");
      const content = await readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      if (Array.isArray(config.customModels)) {
        for (const m of config.customModels) {
          this.models.push({
            id: m.id || m.model || m.displayName,
            name: m.displayName || m.model || m.id,
            provider: m.provider || "factory-custom",
            reasoning: false,
          });
        }
      }
    } catch {
      // config file not found or invalid, ignore
    }

    return this.models;
  }

  /** Set model - sends setting update via RPC */
  async setModel(_provider: string, modelId: string) {
    if (this.process && this.isReady) {
      this.sendRpc("droid.update_session_settings", { modelId });
      this.emitEvent({ type: "model_changed", model: { id: modelId, provider: _provider } });
    }
  }

  /** Set reasoning effort */
  async setThinkingLevel(level: string) {
    const effortMap: Record<string, string> = {
      off: "off", none: "none", low: "low", medium: "medium", high: "high",
    };
    if (this.process && this.isReady) {
      this.sendRpc("droid.update_session_settings", { reasoningEffort: effortMap[level] || level });
    }
    this.emitEvent({ type: "thinking_level_changed", level });
  }

  private async setPermissionMode(mode: "plan" | "full-access") {
    const nextPlanModeEnabled = mode === "plan";
    const nextInteractionMode = nextPlanModeEnabled ? "spec" : "auto";
    const nextAutonomyLevel: "low" | "medium" | "high" = nextPlanModeEnabled ? "medium" : "high";
    const settings: Record<string, unknown> = {};

    this.planModeEnabled = nextPlanModeEnabled;
    if (this.interactionMode !== nextInteractionMode) {
      this.interactionMode = nextInteractionMode;
      settings.interactionMode = nextInteractionMode;
    }
    if (this.autonomyLevel !== nextAutonomyLevel) {
      this.autonomyLevel = nextAutonomyLevel;
      settings.autonomyLevel = nextAutonomyLevel;
    }
    if (this.process && this.isReady && Object.keys(settings).length > 0) {
      await this.sendRpcAsync("droid.update_session_settings", settings);
    }
    this.emitEvent({
      type: "process_event",
      entryType: "status",
      title: nextPlanModeEnabled ? "Droid 已进入 Spec 模式" : "Droid 已开启完全访问模式",
      state: "completed",
    });
  }

  sendUIResponse(response: any) {
    if (!this.process || !this.isReady) return;
    if (this.pendingPermissionRequestId) {
      const answers = Array.isArray(response?.answers) ? response.answers : [];
      const firstAnswer = answers[0] || {};
      const selectedValue = String(
        firstAnswer.value ||
        firstAnswer.answer ||
        firstAnswer.label ||
        response?.value ||
        response?.text ||
        ""
      );
      this.sendRpcResponse(this.pendingPermissionRequestId, {
        selectedOption: selectedValue === "proceed_once" ? "proceed_once" : "deny",
      });
      this.pendingPermissionRequestId = null;
      return;
    }
    if (this.pendingAskUserRequestId) {
      const text =
        typeof response?.text === "string" ? response.text :
        typeof response?.value === "string" ? response.value :
        "";
      this.sendRpcResponse(this.pendingAskUserRequestId, {
        cancelled: false,
        answers: Array.isArray(response?.answers) && response.answers.length > 0
          ? response.answers
          : [{ value: text }],
      });
      this.pendingAskUserRequestId = null;
      return;
    }
    this.process.stdin?.write(JSON.stringify(response) + "\n");
  }

  get sessionFilePath(): string | null { return this.sessionId; }

  /** Dispose and clean up */
  dispose() {
    this.killProcess();
  }

  private killProcess() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.isReady = false;
    this.sessionId = null;
    this.pendingResponses.clear();
    this.pendingAskUserRequestId = null;
    this.pendingPermissionRequestId = null;
    this.eventBuffer.flush();
  }

  // ---- JSON-RPC (Factory protocol) ----

  private sendRpc(method: string, params: any, onResponse?: (data: any) => void): string {
    const id = `rpc-${++this.rpcId}`;
    const msg = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: "1.87.0",
      type: "request",
      id,
      method,
      params,
    };
    if (onResponse) this.pendingResponses.set(id, onResponse);
    this.process?.stdin?.write(JSON.stringify(msg) + "\n");
    return id;
  }

  private sendRpcAsync(method: string, params: any): Promise<any> {
    return new Promise((resolve) => {
      this.sendRpc(method, params, resolve);
    });
  }

  private sendRpcResponse(requestId: string, result: any) {
    const msg = {
      jsonrpc: "2.0",
      factoryApiVersion: "1.0.0",
      factoryProtocolVersion: "1.87.0",
      type: "response",
      id: requestId,
      result,
    };
    this.process?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private handleMessage(data: any) {
    const msgType = data.type;

    if (msgType === "response") {
      // Response to our RPC call
      if (data.id && this.pendingResponses.has(data.id)) {
        const handler = this.pendingResponses.get(data.id)!;
        handler(data);
        this.pendingResponses.delete(data.id);
      }
    } else if (msgType === "notification") {
      // Server-to-client notification
      const method = data.method || data.params?.notification?.type;
      this.handleNotification(method, data.params || data);
    } else if (msgType === "request") {
      // Server-to-client request (permission, ask_user)
      this.handleServerRequest(data.method, data.id, data.params);
    }
  }

  private handleServerRequest(method: string, requestId: string, params: any) {
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
            title: params?.title || params?.message || "Droid 请求权限",
            options: [
              { label: "允许", value: "proceed_once" },
              { label: "拒绝", value: "deny" },
            ],
          }));
        }
        break;
      case "droid.ask_user":
        this.pendingAskUserRequestId = requestId;
        this.emitEvent(normalizeQuestionProcessEvent({ type: method, detail: params }));
        break;
    }
  }

  private handleNotification(method: string, params: any) {
    const notification = params?.notification || params;
    const notifType = notification?.type || method;
    const notifData = notification?.data || notification;

    if (
      isContextCompactionLike(
        method,
        notifType,
        notifData?.type,
        notifData?.name,
        notifData?.title,
        notifData?.message,
        notifData?.status
      )
    ) {
      this.emitEvent({ type: "context_compaction", id: notifData?.id || notification?.id || params?.id });
      return;
    }

    switch (notifType) {
      case "assistant_text_delta":
        this.emitEvent({ type: "stream_delta", delta: notifData?.delta || notifData?.text || "" });
        break;
      case "assistant_text_complete":
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        break;
      case "thinking_text_delta":
        this.emitEvent({ type: "thinking_delta", delta: notifData?.delta || notifData?.text || "" });
        break;
      case "thinking_text_complete":
        this.emitEvent({ type: "thinking_end" });
        break;
      case "droid.ask_user":
      case "ask_user":
      case "ask_user_question":
      case "user_ask_question":
        this.emitEvent(normalizeQuestionProcessEvent({ type: notifType, detail: notifData }));
        break;
      case "tool_progress_update":
        {
          const normalizedInput = {
            toolName: notifData?.toolName || notifData?.name || "tool",
            toolCallId: notifData?.toolCallId || notifData?.id || notifData?.name,
            args: notifData?.args || notifData?.input,
            result: notifData?.result,
            detail: notifData?.message || notifData?.status,
            patch: notifData?.patch || notifData?.diff,
            isError: notifData?.isError || notifData?.status === "error",
          };
          const phase = notifData?.result || notifData?.patch || notifData?.diff || notifData?.status === "completed" || notifData?.status === "error"
            ? "tool_end"
            : "tool_start";
          const toolEvent = normalizeToolEvent(phase, normalizedInput);
          this.emitEvent(toolEvent);
          if (phase === "tool_end") {
            const diffs = buildDiffsFromToolEvent(toolEvent);
            if (diffs.length > 0) this.emitEvent({ type: "diff_update", diffs });
          }
        }
        break;
      case "droid_working_state_changed":
        break;
      case "error":
        this.emitEvent({ type: "stream_delta", delta: `\n\n错误: ${notifData?.message || "未知错误"}` });
        this.emitEvent({ type: "stream_end" });
        this.emitEvent({ type: "agent_end" });
        break;
    }
  }

  private emitEvent(data: unknown) {
    this.eventBuffer.send(data);
  }
}
