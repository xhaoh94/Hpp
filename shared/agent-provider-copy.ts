const ENDPOINT_ALIASES: Record<string, string[]> = {
  "chat-completions": ["chat-completions", "openai-completions", "openai-chat-completions"],
  "openai-completions": ["openai-completions", "chat-completions", "openai-chat-completions"],
  "openai-chat-completions": ["openai-chat-completions", "chat-completions", "openai-completions"],
};

// 中转站的 URL 与 sk-key 通常同时提供 OpenAI Chat 兼容入口，
// 端点只是路径差异，所以源端点不受支持时优先切到这类端点。
const OPENAI_CHAT_ENDPOINTS = [
  "chat-completions",
  "openai-completions",
  "openai-chat-completions",
];

/**
 * 选择目标 Agent 可用的 Endpoint。
 *
 * 先按原端点 / 别名精确匹配；目标不支持原端点时自动切换到 OpenAI Chat 兼容端点，
 * 再退回到 `fallbackEndpoint`（渠道级复制传目标的默认端点）。
 * 模型级覆盖不传 `fallbackEndpoint`，找不到时返回 undefined，由调用方丢弃该覆盖。
 */
export function resolveCompatibleProviderEndpoint(
  sourceEndpoint: string,
  targetEndpoints: Array<string | { id: string }>,
  fallbackEndpoint?: string,
): string | undefined {
  const available = new Set(targetEndpoints.map((endpoint) =>
    typeof endpoint === "string" ? endpoint : endpoint.id
  ));
  const candidates = ENDPOINT_ALIASES[sourceEndpoint] || [sourceEndpoint];
  const matched = candidates.find((endpoint) => available.has(endpoint));
  if (matched) return matched;

  const chatEndpoint = OPENAI_CHAT_ENDPOINTS.find((endpoint) => available.has(endpoint));
  if (chatEndpoint) return chatEndpoint;

  return fallbackEndpoint && available.has(fallbackEndpoint) ? fallbackEndpoint : undefined;
}

export function createCopiedProviderId(sourceProviderId: string, existingProviderIds: Iterable<string>): string {
  const existing = new Set(existingProviderIds);
  if (!existing.has(sourceProviderId)) return sourceProviderId;
  const baseId = `${sourceProviderId}-copy`;
  if (!existing.has(baseId)) return baseId;
  let index = 2;
  while (existing.has(`${baseId}-${index}`)) index += 1;
  return `${baseId}-${index}`;
}
