import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentEvent,
  AgentCompactionConfig,
  AgentImagePayload,
  AgentSendOptions,
  AgentActionListOptions,
  AgentUIResponse,
  AppUpdateStatus,
  SessionDataPurgeRequest,
  DiskUsageStats,
  DiskCleanupResult,
} from "../src/types/ipc";
import { isAgentEvent, isAppUpdateStatus } from "../src/types/ipc";
import type { FileSystemChange } from "../src/types/ipc";
import type { FileFilterConfig } from "../shared/file-filters";
import type {
  PrepareReviewUndoRequest,
  ReviewUndoTarget,
} from "../shared/review-undo";
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
  getAppEnv: () => ipcRenderer.invoke("app:getEnv"),
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
  readDirectory: (dirPath: string, filters?: FileFilterConfig) =>
    ipcRenderer.invoke("fs:readDirectory", dirPath, filters),
  watchPath: (targetPath: string, recursive = false) =>
    ipcRenderer.invoke("fs:watchPath", targetPath, recursive),
  unwatchPath: (targetPath: string, recursive = false) =>
    ipcRenderer.invoke("fs:unwatchPath", targetPath, recursive),
  onFileSystemChange: (callback: (change: FileSystemChange) => void) => {
    const handler = (_event: unknown, data: unknown) => {
      if (!data || typeof data !== "object") return;
      const value = data as Partial<FileSystemChange>;
      if (
        typeof value.path !== "string"
        || (value.eventType !== "change" && value.eventType !== "rename")
      ) return;
      callback({ path: value.path, eventType: value.eventType });
    };
    ipcRenderer.on("fs:change", handler);
    return () => ipcRenderer.removeListener("fs:change", handler);
  },
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke("fs:showItemInFolder", targetPath),
  indexProjectFiles: (dirPath: string, filters?: FileFilterConfig) =>
    ipcRenderer.invoke("fs:indexProjectFiles", dirPath, filters),
  readFile: (filePath: string) => ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke("fs:writeFile", filePath, content),
  readFileDataUrl: (filePath: string) => ipcRenderer.invoke("fs:readFileDataUrl", filePath),
  statPath: (filePath: string) => ipcRenderer.invoke("fs:statPath", filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  fileExists: (filePath: string) =>
    ipcRenderer.invoke("fs:fileExists", filePath),
  loadReviewUndo: (request: PrepareReviewUndoRequest) =>
    ipcRenderer.invoke("fs:loadReviewUndo", request),
  prepareReviewUndo: (request: PrepareReviewUndoRequest) =>
    ipcRenderer.invoke("fs:prepareReviewUndo", request),
  applyReviewUndo: (
    transactionId: string,
    expectedVersion: number,
    target: ReviewUndoTarget,
  ) => ipcRenderer.invoke("fs:applyReviewUndo", transactionId, expectedVersion, target),
  searchFiles: (dirPath: string, query: string, filters?: FileFilterConfig) =>
    ipcRenderer.invoke("fs:searchFiles", dirPath, query, filters),
  openDirectory: () => ipcRenderer.invoke("fs:openDirectory"),
  openAttachmentFolder: () => ipcRenderer.invoke("fs:openAttachmentFolder"),
  getHomeDir: () => ipcRenderer.invoke("fs:getHomeDir"),
  isCommandAvailable: (command: string) => ipcRenderer.invoke("fs:isCommandAvailable", command),
  piSDKGetStatus: () => ipcRenderer.invoke("pi-sdk:getStatus"),
  piSDKUpdate: () => ipcRenderer.invoke("pi-sdk:update"),
  agentGetStatus: (agentId: string) => ipcRenderer.invoke("agent:getStatus", agentId),
  agentGetVersions: (agentId: string) => ipcRenderer.invoke("agent:versions", agentId),
  agentUpdate: (agentId: string, versionSpec?: string) => ipcRenderer.invoke("agent:update", agentId, versionSpec),
  agentRollback: (agentId: string) => ipcRenderer.invoke("agent:rollback", agentId),
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
  agentGetSessionState: (sessionId: string) => ipcRenderer.invoke("agent:getSessionState", sessionId),
  agentGetPendingUIRequests: (sessionId: string) =>
    ipcRenderer.invoke("agent:getPendingUIRequests", sessionId),

  // Data persistence
  loadData: (key: string) => ipcRenderer.invoke("store:load", key),
  saveData: (key: string, data: unknown) =>
    ipcRenderer.invoke("store:save", key, data),
  purgeSessionData: (request: SessionDataPurgeRequest) =>
    ipcRenderer.invoke("store:purgeSessions", request),
  getDiskUsage: (): Promise<DiskUsageStats> => ipcRenderer.invoke("storage:getUsage"),
  cleanupDiskCache: (): Promise<DiskCleanupResult> => ipcRenderer.invoke("storage:cleanup"),

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
  agentSetCompactionConfig: (config: AgentCompactionConfig) =>
    ipcRenderer.invoke("agent:setCompactionConfig", config),
  agentSetAgentCompactionConfig: (agentId: string, config: AgentCompactionConfig) =>
    ipcRenderer.invoke("agent:setAgentCompactionConfig", agentId, config),
  agentConfigList: (agentId: string) =>
    ipcRenderer.invoke("agentConfig:list", agentId),
  agentConfigLookupModel: (agentId: string, modelId: string) =>
    ipcRenderer.invoke("agentConfig:lookupModel", agentId, modelId),
  agentConfigGetModelVisibility: (agentId: string) =>
    ipcRenderer.invoke("agentConfig:getModelVisibility", agentId),
  agentConfigSetBackendModelsVisible: (agentId: string, visible: boolean) =>
    ipcRenderer.invoke("agentConfig:setBackendModelsVisible", agentId, visible),
  agentConfigFetchModels: (baseUrl: string, apiKey: string, endpoint?: string, authMode?: "bearer" | "x-api-key") =>
    ipcRenderer.invoke("agentConfig:fetchModels", baseUrl, apiKey, endpoint, authMode),
  agentConfigSave: (agentId: string, config: unknown) =>
    ipcRenderer.invoke("agentConfig:save", agentId, config),
  agentConfigCopy: (sourceAgentId: string, sourceProviderId: string, targetAgentId: string) =>
    ipcRenderer.invoke("agentConfig:copy", sourceAgentId, sourceProviderId, targetAgentId),
  agentConfigActivate: (agentId: string, providerId: string) =>
    ipcRenderer.invoke("agentConfig:activate", agentId, providerId),
  agentConfigDelete: (agentId: string, providerId: string) =>
    ipcRenderer.invoke("agentConfig:delete", agentId, providerId),
  agentConfigReorder: (agentId: string, providerIds: string[]) =>
    ipcRenderer.invoke("agentConfig:reorder", agentId, providerIds),
  agentConfigExport: (data: unknown) =>
    ipcRenderer.invoke("agentConfig:export", data),
  agentConfigImportRead: () =>
    ipcRenderer.invoke("agentConfig:importRead"),
  agentSendGuidance: (message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) =>
    ipcRenderer.invoke("agent:sendGuidance", message, images, sessionId, options),
  agentAbort: (sessionId?: string) => ipcRenderer.invoke("agent:abort", sessionId),
  agentGetModels: (sessionId?: string) => ipcRenderer.invoke("agent:getModels", sessionId),
  agentListActions: (sessionId?: string, options?: AgentActionListOptions) =>
    ipcRenderer.invoke("agent:listActions", sessionId, options),
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
