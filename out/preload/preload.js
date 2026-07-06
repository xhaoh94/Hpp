"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electronAPI", {
  // Window controls
  minimize: () => electron.ipcRenderer.send("window:minimize"),
  maximize: () => electron.ipcRenderer.send("window:maximize"),
  close: () => electron.ipcRenderer.send("window:close"),
  // Platform info
  platform: process.platform,
  // File system
  readDirectory: (dirPath) => electron.ipcRenderer.invoke("fs:readDirectory", dirPath),
  readFile: (filePath) => electron.ipcRenderer.invoke("fs:readFile", filePath),
  statPath: (filePath) => electron.ipcRenderer.invoke("fs:statPath", filePath),
  getPathForFile: (file) => electron.webUtils.getPathForFile(file),
  fileExists: (filePath) => electron.ipcRenderer.invoke("fs:fileExists", filePath),
  searchFiles: (dirPath, query) => electron.ipcRenderer.invoke("fs:searchFiles", dirPath, query),
  openDirectory: () => electron.ipcRenderer.invoke("fs:openDirectory"),
  openAttachmentFolder: () => electron.ipcRenderer.invoke("fs:openAttachmentFolder"),
  getHomeDir: () => electron.ipcRenderer.invoke("fs:getHomeDir"),
  isCommandAvailable: (command) => electron.ipcRenderer.invoke("fs:isCommandAvailable", command),
  piSDKGetStatus: () => electron.ipcRenderer.invoke("pi-sdk:getStatus"),
  piSDKUpdate: () => electron.ipcRenderer.invoke("pi-sdk:update"),
  agentGetStatus: (agentId) => electron.ipcRenderer.invoke("agent:getStatus", agentId),
  agentUpdate: (agentId) => electron.ipcRenderer.invoke("agent:update", agentId),
  agentGetDefaultThinkingLevel: (agentId) => electron.ipcRenderer.invoke("agent:getDefaultThinkingLevel", agentId),
  // Data persistence
  loadData: (key) => electron.ipcRenderer.invoke("store:load", key),
  saveData: (key, data) => electron.ipcRenderer.invoke("store:save", key, data),
  // Clipboard
  writeImageToClipboard: (imageDataUrl) => electron.ipcRenderer.invoke("clipboard:writeImage", imageDataUrl),
  // Agent
  agentCreateSession: (agentId, projectPath, sessionId, sessionFilePath) => electron.ipcRenderer.invoke("agent:createSession", agentId, projectPath, sessionId, sessionFilePath),
  agentSwitchSession: (sessionId) => electron.ipcRenderer.invoke("agent:switchSession", sessionId),
  agentRemoveSession: (sessionId) => electron.ipcRenderer.invoke("agent:removeSession", sessionId),
  agentSendMessage: (message, images, sessionId, options) => electron.ipcRenderer.invoke("agent:sendMessage", message, images, sessionId, options),
  agentForkSession: (sessionId, target) => electron.ipcRenderer.invoke("agent:forkSession", sessionId, target),
  agentSendGuidance: (message, images, sessionId, options) => electron.ipcRenderer.invoke("agent:sendGuidance", message, images, sessionId, options),
  agentAbort: (sessionId) => electron.ipcRenderer.invoke("agent:abort", sessionId),
  agentGetModels: (sessionId) => electron.ipcRenderer.invoke("agent:getModels", sessionId),
  agentSetModel: (provider, modelId, sessionId) => electron.ipcRenderer.invoke("agent:setModel", provider, modelId, sessionId),
  agentSetThinkingLevel: (level, sessionId) => electron.ipcRenderer.invoke("agent:setThinkingLevel", level, sessionId),
  agentSendUIResponse: (response) => electron.ipcRenderer.invoke("agent:sendUIResponse", response),
  // Agent events
  onAgentEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:event", handler);
    return () => electron.ipcRenderer.removeListener("agent:event", handler);
  }
});
