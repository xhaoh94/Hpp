import { ipcMain } from "electron";
import { getAgentPluginRegistry } from "../agents/agent-plugin-registry";

const registry = getAgentPluginRegistry();

export function registerAgentStatusHandlers() {
  ipcMain.handle("agent:list", async () => registry.listAgents());

  ipcMain.handle("agent:getStatus", async (_event, agentId: string) => {
    return registry.getStatus(agentId);
  });

  ipcMain.handle("agent:getDefaultThinkingLevel", async (_event, agentId: string) => {
    return registry.getDefaultThinkingLevel(agentId);
  });
}
