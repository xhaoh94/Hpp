import { ipcMain, BrowserWindow, app } from "electron";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { OpenCodeAgent } from "./opencode-agent";
import { DroidAgent } from "./droid-agent";
import { PiSDKAgent } from "./pi-sdk-agent";
import { CodexSDKAgent } from "./codex-sdk-agent";

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
  sendMessage(message: string, images?: Array<{ type: string; data: string; mimeType: string }>, options?: AgentSendOptions): Promise<void>;
  abort(): Promise<void>;
  getModels(): Promise<AgentModel[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  sendUIResponse(response: any): void;
  dispose(): void;
  readonly sessionFilePath: string | null;
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  displayMessage?: string;
}

// ============================================================
// Local models.json config support
// ============================================================

interface LocalModelsConfig {
  providers?: Record<string, {
    models?: Array<{ id: string; name?: string; reasoning?: boolean }>;
  }>;
}

let _localModelsConfig: LocalModelsConfig | null = null;
let _localModelsConfigMtime = 0;

/** Read ~/.pi/agent/models.json, cached with mtime check */
function readLocalModelsConfig(): LocalModelsConfig {
  const configPath = join(homedir(), ".pi", "agent", "models.json");
  try {
    const stat = existsSync(configPath) ? statSync(configPath) : null;
    const mtime = stat ? stat.mtimeMs : 0;
    if (_localModelsConfig && mtime <= _localModelsConfigMtime) {
      return _localModelsConfig;
    }
    const content = readFileSync(configPath, "utf-8");
    _localModelsConfig = JSON.parse(content) as LocalModelsConfig;
    _localModelsConfigMtime = mtime;
  } catch {
    _localModelsConfig = {};
    _localModelsConfigMtime = Date.now();
  }
  return _localModelsConfig!;
}

/**
 * Filter fetched models against the local models.json config.
 * If the provider (vendor) is defined in models.json.providers,
 * only return the models whose IDs are listed in that provider's models array.
 * If the provider is NOT configured, return all models for that provider unchanged.
 */
function filterModelsByLocalConfig(models: AgentModel[]): AgentModel[] {
  const config = readLocalModelsConfig();
  if (!config?.providers) return models;

  const result: AgentModel[] = [];
  for (const model of models) {
    const providerConfig = config.providers[model.provider];
    if (!providerConfig?.models) {
      // Provider not configured — keep all models
      result.push(model);
    } else {
      // Provider is configured — only include models whose id matches
      const configuredIds = new Set(providerConfig.models.map((m: any) => m.id));
      if (configuredIds.has(model.id)) {
        // Use the config's model info as-is (id, name, reasoning) to respect custom overrides
        const configuredModel = providerConfig.models.find((m: any) => m.id === model.id);
        result.push({
          ...model,
          name: configuredModel?.name ?? model.name,
          reasoning: configuredModel?.reasoning ?? model.reasoning,
        });
      }
    }
  }
  return result;
}

function supportsNativePlanMode(agentId?: string): boolean {
  return agentId === "codex" || agentId === "opencode" || agentId === "droid";
}

function withPromptPlanMode(message: string): string {
  return [
    "<plan_mode>",
    "Plan mode is enabled for this turn.",
    "Before changing files, running commands, or using tools that modify state, first respond with a concise implementation plan and wait for the user to explicitly confirm.",
    "You may inspect context that is necessary to make the plan. If the user has already explicitly approved a previous plan in this conversation, proceed with the approved implementation.",
    "</plan_mode>",
    "",
    message,
  ].join("\n");
}

// ============================================================
// Agent Manager - supports Pi SDK, OpenCode, and Droid per session
// ============================================================
class AgentManager {
  private sessionAgents = new Map<string, AgentBackend>();
  private sessionAgentTypes = new Map<string, string>(); // sessionId -> agentId ("pi" | "opencode")
  private sessionFilePaths = new Map<string, string>();
  private activeSessionId: string | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) { this.window = win; }

  private createAgentBackend(agentId: string, sessionId: string): AgentBackend {
    if (agentId === "codex") return new CodexSDKAgent(sessionId);
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

  getSessionAgentType(sessionId: string): string | undefined {
    return this.sessionAgentTypes.get(sessionId);
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

  getActiveAgentType(): string | undefined {
    return this.activeSessionId ? this.sessionAgentTypes.get(this.activeSessionId) : undefined;
  }

  async getModelsBySessionId(sessionId: string): Promise<AgentModel[]> {
    const agent = this.sessionAgents.get(sessionId);
    if (!agent) return [];
    const models = await agent.getModels();
    if (this.sessionAgentTypes.get(sessionId) === "codex") return models;
    return filterModelsByLocalConfig(models);
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

  ipcMain.handle("agent:sendMessage", async (_event, message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: AgentSendOptions) => {
    const agent = sessionId ? agentManager.getAgentBySessionId(sessionId) : agentManager.getActiveAgent();
    if (!agent) return { success: false, error: "No active agent" };
    try {
      const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
      const planModeEnabled = !!options?.planModeEnabled;
      const effectiveMessage = planModeEnabled && !supportsNativePlanMode(agentType)
        ? withPromptPlanMode(message)
        : message;
      await agent.sendMessage(effectiveMessage, images, {
        planModeEnabled: planModeEnabled && supportsNativePlanMode(agentType),
        displayMessage: message,
      });
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
    const models = await agent.getModels();
    const agentType = sessionId ? agentManager.getSessionAgentType(sessionId) : agentManager.getActiveAgentType();
    if (agentType === "codex") return models;
    return filterModelsByLocalConfig(models);
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
