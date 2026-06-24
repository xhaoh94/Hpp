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

  // Data persistence
  loadData: (key: string) => ipcRenderer.invoke("store:load", key),
  saveData: (key: string, data: unknown) =>
    ipcRenderer.invoke("store:save", key, data),

  // Agent
  agentCreateSession: (agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) =>
    ipcRenderer.invoke("agent:createSession", agentId, projectPath, sessionId, sessionFilePath),
  agentSwitchSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:switchSession", sessionId),
  agentRemoveSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:removeSession", sessionId),
  agentSendMessage: (message: string, images?: Array<{ type: string; data: string; mimeType: string }>) =>
    ipcRenderer.invoke("agent:sendMessage", message, images),
  agentAbort: () => ipcRenderer.invoke("agent:abort"),
  agentGetModels: () => ipcRenderer.invoke("agent:getModels"),
  agentSetModel: (provider: string, modelId: string) =>
    ipcRenderer.invoke("agent:setModel", provider, modelId),
  agentSetThinkingLevel: (level: string) =>
    ipcRenderer.invoke("agent:setThinkingLevel", level),

  // Agent events
  onAgentEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
});
