import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  showNotification: (options: { title?: string; body?: string }) =>
    ipcRenderer.invoke("app:showNotification", options),

  // File system
  readDirectory: (dirPath: string) =>
    ipcRenderer.invoke("fs:readDirectory", dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke("fs:readFile", filePath),
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

  // Data persistence
  loadData: (key: string) => ipcRenderer.invoke("store:load", key),
  saveData: (key: string, data: unknown) =>
    ipcRenderer.invoke("store:save", key, data),

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
  agentSendMessage: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: { planModeEnabled?: boolean; clientMessageId?: string }) =>
    ipcRenderer.invoke("agent:sendMessage", message, images, sessionId, options),
  agentForkSession: (sessionId: string, target: unknown) =>
    ipcRenderer.invoke("agent:forkSession", sessionId, target),
  agentReloadConfig: (agentId: string, sessionId?: string) =>
    ipcRenderer.invoke("agent:reloadConfig", agentId, sessionId),
  agentConfigList: (agentId: string) =>
    ipcRenderer.invoke("agentConfig:list", agentId),
  agentConfigSave: (agentId: string, config: unknown) =>
    ipcRenderer.invoke("agentConfig:save", agentId, config),
  agentConfigActivate: (agentId: string, providerId: string) =>
    ipcRenderer.invoke("agentConfig:activate", agentId, providerId),
  agentConfigDelete: (agentId: string, providerId: string) =>
    ipcRenderer.invoke("agentConfig:delete", agentId, providerId),
  agentSendGuidance: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: { planModeEnabled?: boolean; clientMessageId?: string }) =>
    ipcRenderer.invoke("agent:sendGuidance", message, images, sessionId, options),
  agentAbort: (sessionId?: string) => ipcRenderer.invoke("agent:abort", sessionId),
  agentGetModels: (sessionId?: string) => ipcRenderer.invoke("agent:getModels", sessionId),
  agentSetModel: (provider: string, modelId: string, sessionId?: string) =>
    ipcRenderer.invoke("agent:setModel", provider, modelId, sessionId),
  agentSetThinkingLevel: (level: string, sessionId?: string) =>
    ipcRenderer.invoke("agent:setThinkingLevel", level, sessionId),
  agentSendUIResponse: (response: any) =>
    ipcRenderer.invoke("agent:sendUIResponse", response),

  // Agent events
  onAgentEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  onAppUpdateStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("app:update-status", handler);
    return () => ipcRenderer.removeListener("app:update-status", handler);
  },
});
