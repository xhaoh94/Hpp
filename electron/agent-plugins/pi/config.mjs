import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ENDPOINT_APIS = {
  "chat-completions": "openai-completions",
  responses: "openai-responses",
  "anthropic-messages": "anthropic-messages",
  "mistral-conversations": "mistral-conversations",
  "azure-openai-responses": "azure-openai-responses",
  "openai-codex-responses": "openai-codex-responses",
  "bedrock-converse-stream": "bedrock-converse-stream",
  "google-generative-ai": "google-generative-ai",
  "google-vertex": "google-vertex",
};

const getConfigPath = () => process.env.PI_CONFIG_PATH || join(homedir(), ".pi", "agent", "models.json");

const getModelsStorePath = () => {
  const configPath = getConfigPath();
  return join(dirname(configPath), "models-store.json");
};

// SDK 内置 catalog 路径：HPP_DATA_DIR/pi-sdk-runtime/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data
const getBuiltinCatalogPath = () => {
  const dataDir = process.env.HPP_DATA_DIR || process.cwd();
  return join(dataDir, "pi-sdk-runtime", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
};

// pi 运行时刷新的渠道目录缓存（与 models.json 同目录）。
// 用于判定"内置能获取到的模型是否有档位声明"：有 thinkingLevelMap 的
// 模型（如 deepseek 的 high/max）可配思考档位；无声明的（如 mimo）只有思考开关。
const directoryStoreCache = new Map();
const getDirectoryStore = () => {
  const storePath = getModelsStorePath();
  let entry = directoryStoreCache.get(storePath);
  if (!entry) {
    entry = (async () => {
      try {
        const store = await readJsonObject(storePath);
        return isRecord(store) ? store : null;
      } catch {
        return null;
      }
    })();
    directoryStoreCache.set(storePath, entry);
  }
  return entry;
};

// SDK 内置 catalog 缓存：直接读取 SDK 包内的 JSON 文件，不需要联网。
// 格式：Map<provider:modelId, modelEntry> 和 Map<modelId, modelEntry>
let builtinCatalogCache = null;
let builtinCatalogLoaded = false;
const getBuiltinCatalog = async () => {
  if (builtinCatalogLoaded) return builtinCatalogCache;
  builtinCatalogLoaded = true;
  const catalogPath = getBuiltinCatalogPath();
  try {
    const files = await readdir(catalogPath);
    const jsonFiles = files.filter((f) => f.endsWith(".json") && f !== ".manifest.json");
    const byProviderAndId = new Map();
    const byId = new Map();
    for (const file of jsonFiles) {
      try {
        const content = await readFile(join(catalogPath, file), "utf8");
        const data = JSON.parse(content);
        if (!isRecord(data)) continue;
        // 每个 JSON 文件格式：{ "api-type": { "model-id": { model-entry } } }
        for (const apiType of Object.keys(data)) {
          const apiModels = data[apiType];
          if (!isRecord(apiModels)) continue;
          for (const modelId of Object.keys(apiModels)) {
            const model = apiModels[modelId];
            if (!isRecord(model) || !model.id) continue;
            const provider = asString(model.provider) || "";
            const key = provider ? `${provider}:${model.id}` : model.id;
            // 优先保留"声明完整"的能力 map
            const existing = byProviderAndId.get(key);
            if (!existing || isBetterCatalogEntry(model, existing)) {
              byProviderAndId.set(key, model);
              // 按 id 兜底时，同样保留一份
              const idKey = model.id;
              const existingById = byId.get(idKey);
              if (!existingById || isBetterCatalogEntry(model, existingById)) {
                byId.set(idKey, model);
              }
            }
          }
        }
      } catch {
        // 单个文件读取失败，继续处理其他文件
      }
    }
    builtinCatalogCache = { byProviderAndId, byId };
    return builtinCatalogCache;
  } catch {
    return null;
  }
};

// 判断 catalog entry 是否比现有的更好：
// 1. 完整声明（7 个标准档都有键）优于不完整声明
// 2. 完整声明之间，显式排除(null)更多的更保守（更准确）
const PI_STANDARD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const isCompleteThinkingLevelMap = (map) =>
  isRecord(map) && PI_STANDARD_THINKING_LEVELS.every((level) => Object.prototype.hasOwnProperty.call(map, level));
const countNullThinkingLevels = (map) =>
  isRecord(map) ? PI_STANDARD_THINKING_LEVELS.filter((level) => map[level] === null).length : 0;
const isBetterCatalogEntry = (candidate, existing) => {
  const candidateMap = isRecord(candidate.thinkingLevelMap) ? candidate.thinkingLevelMap : null;
  const existingMap = isRecord(existing.thinkingLevelMap) ? existing.thinkingLevelMap : null;
  const candidateComplete = candidateMap && isCompleteThinkingLevelMap(candidateMap);
  const existingComplete = existingMap && isCompleteThinkingLevelMap(existingMap);
  if (candidateComplete && !existingComplete) return true;
  if (!candidateComplete && existingComplete) return false;
  if (candidateComplete && existingComplete) {
    return countNullThinkingLevels(candidateMap) > countNullThinkingLevels(existingMap);
  }
  // 都没有完整声明，保留有 reasoning/imageInput 的
  if (candidate.reasoning !== undefined && existing.reasoning === undefined) return true;
  return false;
};

// 在 SDK 内置 catalog 里按 provider + id 查模型条目，找不到时按 id 跨 provider 兜底。
// 返回条目对象（可能无 thinkingLevelMap），用于判定"模型是否内置、内置档位是什么"。
const getDirectoryModelEntry = async (provider, id) => {
  // 优先使用 SDK 内置 catalog（不需要联网）
  const catalog = await getBuiltinCatalog();
  if (catalog) {
    const providerKey = provider ? `${provider}:${id}` : "";
    const providerMatch = providerKey ? catalog.byProviderAndId.get(providerKey) : null;
    if (providerMatch) return providerMatch;
    const idMatch = catalog.byId.get(id);
    if (idMatch) return idMatch;
  }
  // SDK catalog 找不到时，回退到 models-store.json（历史兼容）
  const store = await getDirectoryStore();
  if (!store) return null;
  const findEntry = (models) => models.find((model) => isRecord(model) && model.id === id) || null;
  const providerEntry = isRecord(store[provider]) ? store[provider] : null;
  const providerModels = providerEntry && Array.isArray(providerEntry.models) ? providerEntry.models : [];
  const providerMatch = findEntry(providerModels);
  if (providerMatch) return providerMatch;
  // 按 id 跨 provider 兜底。
  for (const entry of Object.values(store)) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) continue;
    const candidate = findEntry(entry.models);
    if (candidate) return candidate;
  }
  return null;
};

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";
const isMissingFileError = (error) => isRecord(error) && error.code === "ENOENT";

const stripJsonComments = (source) => {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n" && source[index + 1] !== "\r") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length) {
        const commentChar = source[index + 1];
        const commentNext = source[index + 2];
        if (commentChar === "*" && commentNext === "/") {
          result += "  ";
          index += 2;
          break;
        }
        result += commentChar === "\n" || commentChar === "\r" ? commentChar : " ";
        index += 1;
      }
      continue;
    }
    result += char;
  }
  return result;
};

const stripTrailingCommas = (source) => {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += char;
  }
  return result;
};

const parseJsonObject = (source, filePath) => {
  const normalized = stripTrailingCommas(stripJsonComments(source.replace(/^\uFEFF/, "")));
  const parsed = JSON.parse(normalized);
  if (!isRecord(parsed)) throw new Error("configuration root must be a JSON object");
  return parsed;
};

const readJsonObject = async (filePath) => {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
  try {
    return parseJsonObject(content, filePath);
  } catch (error) {
    throw new Error(`Failed to parse Pi config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const writeJsonObject = async (filePath, value) => {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const snapshotFile = async (filePath) => {
  try {
    return { filePath, existed: true, content: await readFile(filePath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { filePath, existed: false, content: "" };
    throw error;
  }
};

export const getProviderEndpoint = (api) => {
  const normalized = asString(api);
  return Object.entries(ENDPOINT_APIS).find(([, nativeApi]) => nativeApi === normalized)?.[0];
};

export const getProviderApi = (endpoint) => Object.prototype.hasOwnProperty.call(ENDPOINT_APIS, endpoint)
  ? ENDPOINT_APIS[endpoint]
  : undefined;

const normalizeModel = async (value, providerId) => {
  if (!isRecord(value)) return null;
  const id = asString(value.id) || asString(value.model) || asString(value.name);
  if (!id) return null;
  const entryMap = isRecord(value.thinkingLevelMap) ? value.thinkingLevelMap : null;
  const savedLevels = entryMap ? mapToSupportedThinkingLevels({ thinkingLevelMap: entryMap }) : [];
  const directoryEntry = providerId ? await getDirectoryModelEntry(providerId, id) : null;
  const directoryMap = isRecord(directoryEntry?.thinkingLevelMap) && Object.keys(directoryEntry.thinkingLevelMap).length > 0
    ? directoryEntry.thinkingLevelMap
    : null;
  // 只有能从 Agent 目录完整取得 reasoning 和 input 能力的模型才算内置；
  // 目录条目残缺时按非内置处理，配置弹窗保留自定义能力控件。
  const isBuiltin = !!directoryEntry
    && typeof directoryEntry.reasoning === "boolean"
    && Array.isArray(directoryEntry.input);
  // 内置模型始终使用目录档位（无 map 即“只有思考开关”），忽略 models.json 里
  // 可能残留的旧自定义 map；非内置模型才使用用户保存的自定义档位。
  const supportedThinkingLevels = isBuiltin
    ? (directoryMap ? mapToSupportedThinkingLevels({ thinkingLevelMap: directoryMap }) : [])
    : savedLevels;
  const directoryReasoning = isBuiltin ? directoryEntry.reasoning === true : null;
  const directoryImageInput = isBuiltin ? directoryEntry.input.includes("image") : null;
  return {
    id,
    name: asString(value.name) || id,
    reasoning: directoryReasoning !== null ? directoryReasoning : (value.reasoning === true),
    imageInput: directoryImageInput !== null ? directoryImageInput : (Array.isArray(value.input) && value.input.includes("image")),
    // 内置模型（目录命中）→ 能力由 Agent 管理，配置弹窗不显示能力控件；
    // 非内置模型（目录里完全没有）→ 显示控件供自定义。
    isBuiltin,
    hasThinkingLevels: !isBuiltin,
    ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
  };
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Reconstruct the supported level list from a pi capability map. */
const mapToSupportedThinkingLevels = (model) => {
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
  if (!map || Object.keys(map).length === 0) return [];
  const standardLevels = THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  const unknownLevels = Object.keys(map).filter((level) =>
    !THINKING_LEVELS.includes(level) && map[level] !== null
  );
  return [...standardLevels, ...unknownLevels];
};

/** Build a pi capability map from a declared supported-level list. */
const supportedThinkingLevelsToMap = (levels) => {
  const supported = new Set(levels.map((level) => String(level || "").trim().toLowerCase()).filter(Boolean));
  const map = {};
  for (const level of ["off", "minimal", "low", "medium", "high"]) {
    if (!supported.has(level)) map[level] = null;
  }
  for (const level of ["xhigh", "max"]) {
    if (supported.has(level)) map[level] = level;
  }
  for (const level of supported) {
    if (!THINKING_LEVELS.includes(level)) map[level] = level;
  }
  return map;
};

const isManagedProvider = (value) => isRecord(value) && !!getProviderEndpoint(value.api);

export const toProviderConfig = (provider, existingProvider = {}) => {
  const api = getProviderApi(provider.endpoint);
  if (!api) throw new Error(`Unsupported Pi endpoint: ${provider.endpoint}`);
  const existing = isRecord(existingProvider) ? existingProvider : {};
  const existingModels = Array.isArray(existing.models) ? existing.models : [];
  const existingModelsById = new Map(existingModels.flatMap((model) => {
    const modelId = isRecord(model) ? asString(model.id) : "";
    return modelId ? [[modelId, model]] : [];
  }));
  const nextProvider = {
    ...existing,
    name: provider.displayName || provider.providerId,
    baseUrl: provider.baseUrl,
    api,
    models: (provider.models || []).map((model) => {
      const existingModel = existingModelsById.get(model.id) || {};
      const declaredLevels = Array.isArray(model.supportedThinkingLevels)
        ? model.supportedThinkingLevels.map((level) => String(level || "").trim().toLowerCase()).filter(Boolean)
        : [];
      const entry = {
        ...existingModel,
        id: model.id,
        name: model.name || model.id,
        // 内置模型的 reasoning 来自目录；自定义模型已由 Hpp 根据档位是否非空派生。
        // 只有支持思考且选了档位才写入自定义 map，否则让运行时回退到内置目录能力。
        reasoning: model.reasoning === true,
        input: model.imageInput ? ["text", "image"] : ["text"],
      };
      if (declaredLevels.length > 0 && model.reasoning === true) {
        entry.thinkingLevelMap = supportedThinkingLevelsToMap(declaredLevels);
      } else {
        delete entry.thinkingLevelMap;
      }
      return entry;
    }),
  };
  if (asString(provider.apiKey)) nextProvider.apiKey = provider.apiKey;
  else delete nextProvider.apiKey;
  return nextProvider;
};

// 未保存前实时判定模型是否内置：与 normalizeModel 的内置判定规则保持一致，
// 供配置弹窗在输入 model-id 时即时隐藏/显示自定义能力控件。
export const lookupModel = async (modelId) => {
  const id = asString(modelId);
  if (!id) return null;
  const directoryEntry = await getDirectoryModelEntry(null, id);
  const isBuiltin = !!directoryEntry
    && typeof directoryEntry.reasoning === "boolean"
    && Array.isArray(directoryEntry.input);
  if (!isBuiltin) return null;
  const directoryMap = isRecord(directoryEntry.thinkingLevelMap) && Object.keys(directoryEntry.thinkingLevelMap).length > 0
    ? directoryEntry.thinkingLevelMap
    : null;
  const supportedThinkingLevels = directoryMap
    ? mapToSupportedThinkingLevels({ thinkingLevelMap: directoryMap })
    : [];
  return {
    isBuiltin: true,
    name: asString(directoryEntry.name) || undefined,
    reasoning: directoryEntry.reasoning === true,
    imageInput: directoryEntry.input.includes("image"),
    ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
  };
};

export const readProviderConfig = async () => {
  const config = await readJsonObject(getConfigPath());
  const providersRecord = isRecord(config.providers) ? config.providers : {};
  const providers = (await Promise.all(
    Object.entries(providersRecord).map(async ([providerId, value]) => {
      if (!isManagedProvider(value)) return [];
      const endpoint = getProviderEndpoint(value.api);
      if (!endpoint) return [];
      const models = Array.isArray(value.models)
        ? (await Promise.all(value.models.map((model) => normalizeModel(model, providerId)))).filter(Boolean)
        : [];
      return [{
        providerId,
        displayName: asString(value.name) || providerId,
        baseUrl: asString(value.baseUrl) || asString(value.baseURL) || asString(value.url),
        apiKey: asString(value.apiKey) || asString(value.api_key),
        endpoint,
        models,
      }];
    }),
  )).flat();
  return {
    activeProviderId: asString(config.activeProviderId) || asString(config.activeProvider) || undefined,
    providers,
  };
};

export const writeProviderConfig = async (state) => {
  const filePath = getConfigPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const existingProviders = isRecord(config.providers) ? config.providers : {};
  const providers = {};
  for (const provider of state.providers || []) {
    providers[provider.providerId] = toProviderConfig(
      provider,
      isRecord(existingProviders[provider.providerId]) ? existingProviders[provider.providerId] : {},
    );
  }
  for (const [providerId, value] of Object.entries(existingProviders)) {
    if (!isManagedProvider(value)) providers[providerId] = value;
  }
  await writeJsonObject(filePath, { ...config, providers });
  return { snapshots: [snapshot] };
};
