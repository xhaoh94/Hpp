import { getStatus as getRuntimeStatus, uninstall as uninstallRuntime, update as updateRuntime } from "./runtime.mjs";

export function createAgentBackend(context) {
  return context.createBuiltinBackend("claude");
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
