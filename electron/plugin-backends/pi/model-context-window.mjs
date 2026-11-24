/**
 * Hpp 统一模型目录的窗口解析（pi worker 侧副本）。
 *
 * 为什么 worker 里还要有一份：pi SDK 自己的自动压缩用 `model.contextWindow`
 * 当分母（`shouldCompact(contextTokens, contextWindow, settings)`），这个值如果
 * 来自 pi 内置 catalogue，就与 Hpp 界面/阈值判定的分母不是一个数——同一个模型
 * 会「界面显示 272k、pi 内部按 400k 触发」，压缩永远偏晚。
 *
 * 匹配规则与 `shared/model-context-catalog.ts` 完全一致（provider 别名/原名精确
 * → 模型家族前缀 → 全库聚合取众数、并列取大）。两者的等价性由
 * `model-context-window.test.ts` 用真实目录逐条比对，改规则必须两边一起改。
 *
 * worker 是独立 .mjs 进程，不能 import TS，所以这里是复制而不是复用。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HPP_CONTEXT_CATALOG_FILE = "model-context-catalog.json";

/** 与 shared/model-context-catalog.ts 的 PROVIDER_ALIASES 保持一致。 */
const PROVIDER_ALIASES = {
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

/** 与 shared/model-context-catalog.ts 的 MODEL_FAMILIES 保持一致。 */
const MODEL_FAMILIES = [
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

const normalizeText = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const getModelIdCandidates = (rawId) => {
  const base = normalizeText(rawId);
  if (!base) return [];
  const candidates = [base];
  const slash = base.lastIndexOf("/");
  if (slash > 0 && slash < base.length - 1) candidates.push(base.slice(slash + 1));
  const withoutSuffix = base.replace(/(:(free|beta|preview|latest|thinking))+$/, "");
  if (withoutSuffix && withoutSuffix !== base) candidates.push(withoutSuffix);
  return [...new Set(candidates)];
};

/** 条目有效窗口：优先输入上限（Hpp 统计的就是输入 token），其次总窗口。 */
const getEntryWindow = (entry) => {
  if (!Array.isArray(entry)) return 0;
  const input = Number(entry[1]);
  if (Number.isFinite(input) && input > 0) return Math.round(input);
  const context = Number(entry[0]);
  if (Number.isFinite(context) && context > 0) return Math.round(context);
  return 0;
};

/**
 * 把目录压成两张索引：provider 精确表和 id 聚合表（众数、并列取大）。
 * 目录上万条，建一次索引后单次解析是 O(1)。
 */
export function createHppContextWindowIndex(catalog) {
  if (!catalog || typeof catalog !== "object") return null;
  const providers = catalog.providers;
  if (!providers || typeof providers !== "object") return null;
  const providerIndex = new Map();
  const counts = new Map();
  for (const [rawProvider, models] of Object.entries(providers)) {
    if (!models || typeof models !== "object") continue;
    const provider = normalizeText(rawProvider);
    if (!provider) continue;
    const table = new Map();
    for (const [rawModel, entry] of Object.entries(models)) {
      const modelId = normalizeText(rawModel);
      const window = getEntryWindow(entry);
      if (!modelId || !window) continue;
      table.set(modelId, window);
      let byWindow = counts.get(modelId);
      if (!byWindow) {
        byWindow = new Map();
        counts.set(modelId, byWindow);
      }
      byWindow.set(window, (byWindow.get(window) || 0) + 1);
    }
    if (table.size > 0) providerIndex.set(provider, table);
  }
  if (providerIndex.size === 0) return null;
  const aggregate = new Map();
  for (const [modelId, byWindow] of counts) {
    let best;
    for (const [window, count] of byWindow) {
      if (!best || count > best.count || (count === best.count && window > best.window)) {
        best = { window, count };
      }
    }
    if (best) aggregate.set(modelId, best.window);
  }
  return { providerIndex, aggregate };
}

const lookupProvider = (index, provider, modelId) => {
  const table = index.providerIndex.get(provider);
  return (table && table.get(modelId)) || 0;
};

const getFamilyProvider = (modelId) => {
  const hit = MODEL_FAMILIES.find(([pattern]) => pattern.test(modelId));
  return hit ? hit[1] : "";
};

const resolveProviderIds = (provider) => {
  const normalized = normalizeText(provider);
  if (!normalized) return [];
  const alias = PROVIDER_ALIASES[normalized];
  return alias && alias !== normalized ? [alias, normalized] : [normalized];
};

/** 解析某个渠道模型的统一窗口；命中不到返回 0（调用方保留自己的值）。 */
export function resolveHppContextWindow(index, provider, modelId) {
  if (!index) return 0;
  const candidates = getModelIdCandidates(modelId);
  if (candidates.length === 0) return 0;
  const providerIds = resolveProviderIds(provider);
  for (const candidate of candidates) {
    for (const providerId of providerIds) {
      const hit = lookupProvider(index, providerId, candidate);
      if (hit) return hit;
    }
    const family = getFamilyProvider(candidate);
    if (family) {
      const hit = lookupProvider(index, family, candidate);
      if (hit) return hit;
    }
  }
  for (const candidate of candidates) {
    const hit = index.aggregate.get(candidate) || 0;
    if (hit) return hit;
  }
  return 0;
}

/**
 * 读 Hpp 的目录：优先运行时缓存（每日刷新写入的那份），再回退内置快照。
 * 两条都读不到就返回 null，worker 继续用 pi 自己的 catalogue。
 */
export function loadHppContextWindowIndex(options = {}) {
  const { dataDir = "", bundledPath = "", readFile = readFileSync } = options;
  const candidates = [];
  if (dataDir) candidates.push(join(dataDir, HPP_CONTEXT_CATALOG_FILE));
  if (bundledPath) candidates.push(bundledPath);
  for (const candidate of candidates) {
    try {
      const index = createHppContextWindowIndex(JSON.parse(readFile(candidate, "utf8")));
      if (index) return index;
    } catch {
      // 缓存损坏或还没生成：继续试下一个。
    }
  }
  return null;
}
