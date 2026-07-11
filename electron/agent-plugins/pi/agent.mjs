export async function createAgentBackend(context) {
  return context.createBuiltinBackend("pi");
}

export function getStatus(context) {
  return context.host.getPiSDKStatus(context.pluginDir);
}

export function update(context) {
  return context.host.updatePiSDK();
}

export function getDefaultThinkingLevel() {
  return "medium";
}
