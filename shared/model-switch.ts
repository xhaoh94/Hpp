export function formatModelSwitchToastText(
  requiresProviderActivation: boolean,
  provider: string,
  modelName: string,
) {
  return requiresProviderActivation
    ? `已切换至 ${modelName}（${provider} 渠道）`
    : `已切换至 ${modelName}`;
}
