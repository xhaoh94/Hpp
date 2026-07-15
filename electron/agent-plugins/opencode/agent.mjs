import { readProviderConfig, writeProviderConfig } from "./config.mjs";

export async function createAgentBackend(context) {
  return context.createBuiltinBackend("opencode");
}

export function getStatus(context) {
  return context.host.getCliAgentStatus({
    id: context.agentId,
    name: "OpenCode",
    source: "plugin",
    removable: true,
    command: "opencode",
    packageName: "opencode-ai",
    installedPath: context.pluginDir
  });
}

export function update(context) {
  return context.host.updateCliAgent({
    id: context.agentId,
    name: "OpenCode",
    source: "plugin",
    removable: true,
    command: "opencode",
    packageName: "opencode-ai",
    installedPath: context.pluginDir
  });
}

export function getDefaultThinkingLevel() {
  return "medium";
}

export const configProvider = {
  read() {
    return readProviderConfig();
  },
  write(_context, { state }) {
    return writeProviderConfig(state);
  },
};
