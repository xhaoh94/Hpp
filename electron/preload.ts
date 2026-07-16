import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentEvent,
  AgentImagePayload,
  AgentSendOptions,
  AgentUIResponse,
  AppUpdateStatus,
} from "../src/types/ipc";
import { isAgentEvent, isAppUpdateStatus } from "../src/types/ipc";
import type {
  RemoteAccessStatus,
  RemotePairingOffer,
  RemoteRendererCommand,
  RemoteRendererCommandResult,
  RemoteRendererPublish,
} from "../shared/remote-protocol";

contextBridge.exposeInMainWorld("electronAPI", {
  // Window controls
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),

  // Platform info
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  getAppUpdateStatus: () => ipcRenderer.invoke("app:update:getStatus"),
  checkAppUpdate: () => ipcRenderer.invoke("app:update:check"),
  downloadAppUpdate: () => ipcRenderer.invoke("app:update:download"),
  installAppUpdate: () => ipcRenderer.invoke("app:update:install"),
  getCloseToTray: () => ipcRenderer.invoke("app:getCloseToTray"),
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke("app:setCloseToTray", enabled),
  setAppTheme: (theme: "system" | "light" | "dark") => ipcRenderer.invoke("app:setTheme", theme),
  showNotification: (options: { title?: string; body?: string }) =>
    ipcRenderer.invoke("app:showNotification", options),

  // File system
  readDirectory: (dirPath: string) =>
    ipcRenderer.invoke("fs:readDirectory", dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke("fs:readFile", filePath),
  readFileDataUrl: (filePath: string) => ipcRenderer.invoke("fs:readFileDataUrl", filePath),
  statPath: (filePath: string) => ipcRenderer.invoke("fs:statPath", filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  fileExists: (filePath: string) =>
    ipcRenderer.invoke("fs:fileExists", filePath),
  reverseApplyPatch: (projectPath: string, patches: string[]) =>
    ipcRenderer.invoke("fs:reverseApplyPatch", projectPath, patches),
  searchFiles: (dirPath: string, query: string) =>
    ipcRenderer.invoke("fs:searchFiles", dirPath, query),
  openDirectory: () => ipcRenderer.invoke("fs:openDirectory"),
  openAttachmentFolder: () => ipcRenderer.invoke("fs:openAttachmentFolder"),
  getHomeDir: () => ipcRenderer.invoke("fs:getHomeDir"),
  isCommandAvailable: (command: string) => ipcRenderer.invoke("fs:isCommandAvailable", command),
  piSDKGetStatus: () => ipcRenderer.invoke("pi-sdk:getStatus"),
  piSDKUpdate: () => ipcRenderer.invoke("pi-sdk:update"),
  agentGetStatus: (agentId: string) => ipcRenderer.invoke("agent:getStatus", agentId),
  agentUpdate: (agentId: string) => ipcRenderer.invoke("agent:update", agentId),
  agentGetDefaultThinkingLevel: (agentId: string) =>
    ipcRenderer.invoke("agent:getDefaultThinkingLevel", agentId),
  agentList: () => ipcRenderer.invoke("agent:list"),
  agentPluginChoosePath: (kind?: "zip" | "directory") => ipcRenderer.invoke("agentPlugin:choosePath", kind),
  agentPluginInstallFromPath: (pluginPath: string) =>
    ipcRenderer.invoke("agentPlugin:installFromPath", pluginPath),
  agentPluginListOfficial: () => ipcRenderer.invoke("agentPlugin:listOfficial"),
  agentPluginInstallOfficial: (agentId: string) =>
    ipcRenderer.invoke("agentPlugin:installOfficial", agentId),
  agentPluginRemove: (agentId: string, removeRuntime = false) =>
    ipcRenderer.invoke("agentPlugin:remove", agentId, removeRuntime),
  agentPluginReload: () => ipcRenderer.invoke("agentPlugin:reload"),

  // Data persistence
  loadData: (key: string) => ipcRenderer.invoke("store:load", key),
  saveData: (key: string, data: unknown) =>
    ipcRenderer.invoke("store:save", key, data),

  // Remote access
  remoteGetAccessStatus: (): Promise<RemoteAccessStatus> =>
    ipcRenderer.invoke("remote:getStatus"),
  remoteConfigureAccess: (patch: Partial<Pick<RemoteAccessStatus, "enabled" | "bindAddress" | "advertiseAddress" | "port">>): Promise<RemoteAccessStatus> =>
    ipcRenderer.invoke("remote:configure", patch),
  remoteBeginPairing: (): Promise<RemotePairingOffer> =>
    ipcRenderer.invoke("remote:beginPairing"),
  remoteRevokeDevice: (deviceId: string): Promise<RemoteAccessStatus> =>
    ipcRenderer.invoke("remote:revokeDevice", deviceId),
  remotePublish: (update: RemoteRendererPublish) =>
    ipcRenderer.send("remote:publish", update),
  remoteCommandResult: (result: RemoteRendererCommandResult) =>
    ipcRenderer.send("remote:commandResult", result),
  onRemoteCommand: (callback: (command: RemoteRendererCommand) => void) => {
    const handler = (_event: unknown, command: RemoteRendererCommand) => callback(command);
    ipcRenderer.on("remote:command", handler);
    return () => ipcRenderer.removeListener("remote:command", handler);
  },

  // Clipboard
  writeImageToClipboard: (imageDataUrl: string) =>
    ipcRenderer.invoke("clipboard:writeImage", imageDataUrl),

  // Agent
  agentCreateSession: (agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) =>
    ipcRenderer.invoke("agent:createSession", agentId, projectPath, sessionId, sessionFilePath),
  agentSwitchSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:switchSession", sessionId),
  agentRemoveSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:removeSession", sessionId),
  agentSendMessage: (message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) =>
    ipcRenderer.invoke("agent:sendMessage", message, images, sessionId, options),
  agentForkSession: (sessionId: string, target: unknown) =>
    ipcRenderer.invoke("agent:forkSession", sessionId, target),
  agentReloadConfig: (agentId: string, sessionId?: string) =>
    ipcRenderer.invoke("agent:reloadConfig", agentId, sessionId),
  agentConfigList: (agentId: string) =>
    ipcRenderer.invoke("agentConfig:list", agentId),
  agentConfigGetModelVisibility: (agentId: string) =>
    ipcRenderer.invoke("agentConfig:getModelVisibility", agentId),
  agentConfigSetBackendModelsVisible: (agentId: string, visible: boolean) =>
    ipcRenderer.invoke("agentConfig:setBackendModelsVisible", agentId, visible),
  agentConfigFetchModels: (baseUrl: string, apiKey: string) =>
    ipcRenderer.invoke("agentConfig:fetchModels", baseUrl, apiKey),
  agentConfigSave: (agentId: string, config: unknown) =>
    ipcRenderer.invoke("agentConfig:save", agentId, config),
  agentConfigActivate: (agentId: string, providerId: string) =>
    ipcRenderer.invoke("agentConfig:activate", agentId, providerId),
  agentConfigDelete: (agentId: string, providerId: string) =>
    ipcRenderer.invoke("agentConfig:delete", agentId, providerId),
  agentConfigReorder: (agentId: string, providerIds: string[]) =>
    ipcRenderer.invoke("agentConfig:reorder", agentId, providerIds),
  agentSendGuidance: (message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) =>
    ipcRenderer.invoke("agent:sendGuidance", message, images, sessionId, options),
  agentAbort: (sessionId?: string) => ipcRenderer.invoke("agent:abort", sessionId),
  agentGetModels: (sessionId?: string) => ipcRenderer.invoke("agent:getModels", sessionId),
  agentSetModel: (provider: string, modelId: string, sessionId?: string) =>
    ipcRenderer.invoke("agent:setModel", provider, modelId, sessionId),
  agentSetThinkingLevel: (level: string, sessionId?: string) =>
    ipcRenderer.invoke("agent:setThinkingLevel", level, sessionId),
  agentSendUIResponse: (response: AgentUIResponse) =>
    ipcRenderer.invoke("agent:sendUIResponse", response),

  // Agent events
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const handler = (_event: unknown, data: unknown) => {
      if (isAgentEvent(data)) callback(data);
    };
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  onAppUpdateStatus: (callback: (status: AppUpdateStatus) => void) => {
    const handler = (_event: unknown, data: unknown) => {
      if (isAppUpdateStatus(data)) callback(data);
    };
    ipcRenderer.on("app:update-status", handler);
    return () => ipcRenderer.removeListener("app:update-status", handler);
  },
});
