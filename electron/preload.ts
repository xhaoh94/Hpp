import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // Window controls
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),

  // Platform info
  platform: process.platform,

  // File system
  readDirectory: (dirPath: string) =>
    ipcRenderer.invoke("fs:readDirectory", dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke("fs:readFile", filePath),
  fileExists: (filePath: string) =>
    ipcRenderer.invoke("fs:fileExists", filePath),
  searchFiles: (dirPath: string, query: string) =>
    ipcRenderer.invoke("fs:searchFiles", dirPath, query),
  openDirectory: () => ipcRenderer.invoke("fs:openDirectory"),
  getHomeDir: () => ipcRenderer.invoke("fs:getHomeDir"),
  isCommandAvailable: (command: string) => ipcRenderer.invoke("fs:isCommandAvailable", command),
  piSDKGetStatus: () => ipcRenderer.invoke("pi-sdk:getStatus"),
  piSDKUpdate: () => ipcRenderer.invoke("pi-sdk:update"),
  agentGetStatus: (agentId: string) => ipcRenderer.invoke("agent:getStatus", agentId),
  agentUpdate: (agentId: string) => ipcRenderer.invoke("agent:update", agentId),

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
  agentSendMessage: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: { planModeEnabled?: boolean }) =>
    ipcRenderer.invoke("agent:sendMessage", message, images, sessionId, options),
  agentSendGuidance: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>, sessionId?: string, options?: { planModeEnabled?: boolean }) =>
    ipcRenderer.invoke("agent:sendGuidance", message, images, sessionId, options),
  agentAbort: (sessionId?: string) => ipcRenderer.invoke("agent:abort", sessionId),
  agentGetModels: (sessionId?: string) => ipcRenderer.invoke("agent:getModels", sessionId),
  agentSetModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke("agent:setModel", provider, modelId),
  agentSetThinkingLevel: (level: string) =>
    ipcRenderer.invoke("agent:setThinkingLevel", level),
  agentSendUIResponse: (response: any) =>
    ipcRenderer.invoke("agent:sendUIResponse", response),

  // Agent events
  onAgentEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
});
