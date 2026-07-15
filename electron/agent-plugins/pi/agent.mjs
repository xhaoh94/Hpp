import { readProviderConfig, writeProviderConfig } from "./config.mjs";
import { getStatus as getRuntimeStatus, uninstall as uninstallRuntime, update as updateRuntime } from "./runtime.mjs";

export async function createAgentBackend(context) {
  return context.createBuiltinBackend("pi");
}

export function getStatus(context) {
  return getRuntimeStatus(context);
}

export function update(context) {
  return updateRuntime(context);
}

export function uninstall(context) {
  return uninstallRuntime(context);
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
