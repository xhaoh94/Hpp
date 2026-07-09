export function createAgentBackend(context) {
  return context.host.createCodexAgentBackend(context.sessionId);
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

export function getDefaultThinkingLevel(context) {
  return context.host.getCodexDefaultThinkingLevel();
}

export const configProvider = {
  async activateProvider(context, { provider, state }) {
    if (typeof context.host.writeCodexNativeProviderConfig !== "function") {
      throw new Error("Host does not support Codex provider activation.");
    }
    return context.host.writeCodexNativeProviderConfig({ provider, state });
  }
};
