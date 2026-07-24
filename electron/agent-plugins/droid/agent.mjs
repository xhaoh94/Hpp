import { readProviderConfig, writeProviderConfig } from "./config.mjs";

export async function createAgentBackend(context) {
  return context.createBuiltinBackend("droid");
}

export function getStatus(context) {
  return context.host.getCliAgentStatus({
    id: context.agentId,
    name: "Droid",
    source: "plugin",
    removable: true,
    command: "droid",
    packageName: "droid",
    installedPath: context.pluginDir
  });
}

export function update(context, options = {}) {
  return context.host.updateCliAgent({
    id: context.agentId,
    name: "Droid",
    source: "plugin",
    removable: true,
    command: "droid",
    packageName: "droid",
    installedPath: context.pluginDir
  }, options.versionSpec);
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
