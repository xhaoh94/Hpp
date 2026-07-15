import { activateProvider, getDefaultThinkingLevel as readDefaultThinkingLevel, readProviderConfig } from "./config.mjs";

export async function createAgentBackend(context) {
  return context.createBuiltinBackend("codex");
}

export function getStatus(context) {
  return context.host.getCliAgentStatus({
    id: context.agentId,
    name: "Codex",
    source: "plugin",
    removable: true,
    command: "codex",
    packageName: "@openai/codex",
    installedPath: context.pluginDir
  });
}

export function update(context) {
  return context.host.updateCliAgent({
    id: context.agentId,
    name: "Codex",
    source: "plugin",
    removable: true,
    command: "codex",
    packageName: "@openai/codex",
    installedPath: context.pluginDir
  });
}

export function getDefaultThinkingLevel() {
  return readDefaultThinkingLevel();
}

export const configProvider = {
  read() {
    return readProviderConfig();
  },
  activateProvider(_context, { provider }) {
    return activateProvider(provider);
  },
};
