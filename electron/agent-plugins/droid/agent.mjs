export function createAgentBackend(context) {
  return context.host.createDroidAgentBackend(context.sessionId);
}

export function getStatus(context) {
  return context.host.getCliAgentStatus({
    id: context.agentId,
    name: "Factory Droid",
    source: "plugin",
    removable: true,
    command: "droid",
    packageName: "droid",
    installedPath: context.pluginDir
  });
}

export function update(context) {
  return context.host.updateCliAgent({
    id: context.agentId,
    name: "Factory Droid",
    source: "plugin",
    removable: true,
    command: "droid",
    packageName: "droid",
    installedPath: context.pluginDir
  });
}

export function getDefaultThinkingLevel() {
  return "medium";
}
