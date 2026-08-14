import { activateProvider, getDefaultThinkingLevel as readDefaultThinkingLevel, lookupModel, readProviderConfig } from "./config.mjs";

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

export function update(context, options = {}) {
  return context.host.updateCliAgent({
    id: context.agentId,
    name: "Codex",
    source: "plugin",
    removable: true,
    command: "codex",
    packageName: "@openai/codex",
    installedPath: context.pluginDir
  }, options.versionSpec);
}

export function getDefaultThinkingLevel() {
  return readDefaultThinkingLevel();
}

export const configProvider = {
  read(_context, args = {}) {
    return readProviderConfig(args.realtimeModels);
  },
  activateProvider(_context, { provider }) {
    return activateProvider(provider);
  },
  lookupModel(_context, args = {}) {
    return lookupModel(args.modelId, args.realtimeModels);
  },
};
