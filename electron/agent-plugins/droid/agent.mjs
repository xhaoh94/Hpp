export async function createAgentBackend(context) {
  return context.createBuiltinBackend("droid");
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
