const ENDPOINT_ALIASES: Record<string, string[]> = {
  "chat-completions": ["chat-completions", "openai-completions", "openai-chat-completions"],
  "openai-completions": ["openai-completions", "chat-completions", "openai-chat-completions"],
  "openai-chat-completions": ["openai-chat-completions", "chat-completions", "openai-completions"],
};

export function resolveCompatibleProviderEndpoint(
  sourceEndpoint: string,
  targetEndpoints: Array<string | { id: string }>,
): string | undefined {
  const available = new Set(targetEndpoints.map((endpoint) =>
    typeof endpoint === "string" ? endpoint : endpoint.id
  ));
  const candidates = ENDPOINT_ALIASES[sourceEndpoint] || [sourceEndpoint];
  return candidates.find((endpoint) => available.has(endpoint));
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
