/**
 * 统一的模型上下文窗口目录（来源 models.dev）。
 *
 * 四个插件（pi / claude / codex / opencode）各自维护一份模型元数据，同一个模型
 * 在不同插件里给出的窗口可能相差一倍以上：pi 用渠道声明的值或模型目录，codex
 * 用 app-server 上报的 modelContextWindow（已扣掉推理/输出预留），claude 用
 * getContextUsage 的有效上限，opencode 用 providers 接口的 limit.context。
 * 结果就是「同一个模型，切个插件上限就变」。
 *
 * 这里把 models.dev 的快照压成一张精简表，由 Hpp 统一解析，各插件只当数据源。
 * 匹配规则（依次尝试，命中即止）：
 *   1. provider 别名 / 原名 + 模型 id 精确匹配；
 *   2. 模型 id 的家族前缀对应的第一方 provider（claude-* → anthropic 等）；
 *   3. 只按模型 id 在全库聚合：取出现次数最多的窗口（并列取较大值）。
 * 都不命中就返回 undefined —— 不猜，保留插件自己上报的值。
 */

/** `[context, input?]`，input 缺省表示目录里只给了总窗口。 */
export type ModelContextCatalogEntry = [number] | [number, number];

export interface ModelContextCatalogData {
  /** 数据格式版本，用于丢弃旧缓存。 */
  version: number;
  /** 数据来源说明，只用于诊断展示。 */
  source: string;
  /** 抓取时间（ISO），用于判断是否需要刷新。 */
  fetchedAt?: string;
  /** 上次抓取的 ETag，条件请求用。 */
  etag?: string;
  providers: Record<string, Record<string, ModelContextCatalogEntry>>;
}

export type ModelContextMatchKind = "provider" | "family" | "aggregate";

export interface ModelContextWindowResolution {
  /** 统一后的上下文窗口（token）。 */
  window: number;
  /** 提供该值的目录 provider（诊断用）。 */
  provider: string;
  /** 命中的目录模型 id（诊断用）。 */
  modelId: string;
  matchedBy: ModelContextMatchKind;
}

export const MODEL_CONTEXT_CATALOG_VERSION = 1;

/**
 * 插件侧 provider id → models.dev provider id。
 * 只登记「名字不一样」的；同名（openai / anthropic / deepseek / opencode …）
 * 直接精确匹配，不需要别名。
 */
const PROVIDER_ALIASES: Record<string, string> = {
  codex: "openai",
  "openai-codex": "openai",
  chatgpt: "openai",
  claude: "anthropic",
  "claude-code": "anthropic",
  gemini: "google",
  "google-gemini": "google",
  vertex: "google",
  vertexai: "google",
  zhipu: "zhipuai",
  bigmodel: "zhipuai",
  glm: "zai",
  moonshot: "moonshotai",
  kimi: "moonshotai",
  xai: "x-ai",
  qwen: "alibaba",
  dashscope: "alibaba",
};

/**
 * 模型 id 家族前缀 → 第一方 provider。
 * 用途：聚合商的模型（`tanwan/gpt-6.2-astra`）在目录里往往没有对应 provider，
 * 但同一 id 一定出现在第一方条目下，用家族名兜底比「全库取众数」更准。
 */
const MODEL_FAMILIES: Array<[RegExp, string]> = [
  [/^claude/, "anthropic"],
  [/^(gpt-|o[1-9](-|$)|chatgpt|codex-|text-embedding|dall-e)/, "openai"],
  [/^gemini/, "google"],
  [/^glm/, "zai"],
  [/^deepseek/, "deepseek"],
  [/^qwen/, "alibaba"],
  [/^(kimi|moonshot)/, "moonshotai"],
  [/^minimax/, "minimax"],
  [/^(mistral|magistral|codestral|devstral|pixtral)/, "mistral"],
  [/^llama/, "meta"],
  [/^grok/, "xai"],
];

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * 模型 id 的候选写法（按优先级）：
 * 原名 → 去掉 `vendor/` 前缀 → 去掉 `:free` 这类发布后缀。
 * 聚合渠道常把 `deepseek/deepseek-v4.1-flash` 整串当 id，目录里存的是后半段。
 */
export function getCatalogModelIdCandidates(rawId: unknown): string[] {
  const base = normalizeText(rawId);
  if (!base) return [];
  const candidates = [base];
  const slash = base.lastIndexOf("/");
  if (slash > 0 && slash < base.length - 1) candidates.push(base.slice(slash + 1));
  const withoutSuffix = base.replace(/(:(free|beta|preview|latest|thinking))+$/, "");
  if (withoutSuffix && withoutSuffix !== base) candidates.push(withoutSuffix);
  return [...new Set(candidates)];
}

/** 条目里的有效窗口：优先输入上限（Hpp 统计的就是输入 token），其次总窗口。 */
export function getCatalogEntryWindow(entry: ModelContextCatalogEntry | undefined): number | undefined {
  if (!Array.isArray(entry)) return undefined;
  const input = Number(entry[1]);
  if (Number.isFinite(input) && input > 0) return Math.round(input);
  const context = Number(entry[0]);
  if (Number.isFinite(context) && context > 0) return Math.round(context);
  return undefined;
}

const resolveProviderId = (provider: string): string[] => {
  const normalized = normalizeText(provider);
  if (!normalized) return [];
  const alias = PROVIDER_ALIASES[normalized];
  return alias && alias !== normalized ? [alias, normalized] : [normalized];
};

const getFamilyProvider = (modelId: string): string | undefined =>
  MODEL_FAMILIES.find(([pattern]) => pattern.test(modelId))?.[1];

const lookupProviderEntry = (
  data: ModelContextCatalogData,
  provider: string,
  modelId: string,
): { window: number; provider: string; modelId: string } | undefined => {
  const models = data.providers?.[provider];
  if (!models) return undefined;
  const entry = models[modelId];
  const window = getCatalogEntryWindow(entry);
  return window ? { window, provider, modelId } : undefined;
};

/**
 * 全库聚合：同一个 id 在几十个中转渠道下可能给出不同窗口，
 * 取出现次数最多的那个（并列取较大值），避免被单个小渠道带偏。
 */
const aggregateById = (
  data: ModelContextCatalogData,
  modelId: string,
): { window: number; provider: string; modelId: string } | undefined => {
  const counts = new Map<number, { count: number; provider: string }>();
  for (const [provider, models] of Object.entries(data.providers || {})) {
    const window = getCatalogEntryWindow(models?.[modelId]);
    if (!window) continue;
    const current = counts.get(window);
    if (current) current.count += 1;
    else counts.set(window, { count: 1, provider });
  }
  let best: { window: number; count: number; provider: string } | undefined;
  for (const [window, info] of counts) {
    if (!best || info.count > best.count || (info.count === best.count && window > best.window)) {
      best = { window, count: info.count, provider: info.provider };
    }
  }
  return best ? { window: best.window, provider: best.provider, modelId } : undefined;
};

/**
 * 解析某个渠道模型的统一上下文窗口。命中不到返回 undefined（调用方保留原值）。
 */
export function resolveModelContextWindow(
  data: ModelContextCatalogData | null | undefined,
  input: { provider?: unknown; modelId?: unknown },
): ModelContextWindowResolution | undefined {
  if (!data?.providers) return undefined;
  const candidates = getCatalogModelIdCandidates(input.modelId);
  if (candidates.length === 0) return undefined;
  const providerIds = resolveProviderId(normalizeText(input.provider));

  for (const modelId of candidates) {
    for (const provider of providerIds) {
      const hit = lookupProviderEntry(data, provider, modelId);
      if (hit) return { ...hit, matchedBy: "provider" };
    }
    const family = getFamilyProvider(modelId);
    if (family) {
      const hit = lookupProviderEntry(data, family, modelId);
      if (hit) return { ...hit, matchedBy: "family" };
    }
  }

  for (const modelId of candidates) {
    const hit = aggregateById(data, modelId);
    if (hit) return { ...hit, matchedBy: "aggregate" };
  }
  return undefined;
}

/** 是否是需要刷新（缓存过期）的目录：没有抓取时间或超过 maxAgeMs。 */
export function shouldRefreshModelContextCatalog(
  data: ModelContextCatalogData | null | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!data?.providers || Object.keys(data.providers).length === 0) return true;
  const fetchedAt = data.fetchedAt ? Date.parse(data.fetchedAt) : Number.NaN;
  if (!Number.isFinite(fetchedAt)) return true;
  return now - fetchedAt >= maxAgeMs;
}

/**
 * models.dev 的 `api.json` → 精简表。
 * 只保留有窗口的模型，provider / model 名统一小写，方便精确命中。
 */
export function compactModelContextCatalog(
  payload: unknown,
  options: { fetchedAt?: string; etag?: string; source?: string } = {},
): ModelContextCatalogData {
  const providers: Record<string, Record<string, ModelContextCatalogEntry>> = {};
  const rawProviders = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
  for (const [rawProviderId, rawProvider] of Object.entries(rawProviders)) {
    const providerId = normalizeText(rawProviderId);
    const models = rawProvider && typeof rawProvider === "object"
      ? (rawProvider as { models?: unknown }).models
      : undefined;
    if (!providerId || !models || typeof models !== "object") continue;
    const entries: Record<string, ModelContextCatalogEntry> = {};
    for (const [rawModelId, rawModel] of Object.entries(models as Record<string, unknown>)) {
      const modelId = normalizeText(rawModelId);
      if (!modelId || !rawModel || typeof rawModel !== "object") continue;
      const limit = (rawModel as { limit?: unknown }).limit;
      if (!limit || typeof limit !== "object") continue;
      const { context, input } = limit as { context?: unknown; input?: unknown };
      const contextValue = Number(context);
      const inputValue = Number(input);
      const hasContext = Number.isFinite(contextValue) && contextValue > 0;
      const hasInput = Number.isFinite(inputValue) && inputValue > 0;
      if (!hasContext && !hasInput) continue;
      const contextTokens = hasContext ? Math.round(contextValue) : Math.round(inputValue);
      entries[modelId] = hasInput
        ? [contextTokens, Math.round(inputValue)]
        : [contextTokens];
    }
    if (Object.keys(entries).length > 0) providers[providerId] = entries;
  }
  return {
    version: MODEL_CONTEXT_CATALOG_VERSION,
    source: options.source || "models.dev",
    fetchedAt: options.fetchedAt,
    ...(options.etag ? { etag: options.etag } : {}),
    providers,
  };
}
