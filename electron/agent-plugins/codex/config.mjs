import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_MODEL_ID = "gpt-5.5";
const DEFAULT_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const getCodexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const getConfigPath = () => join(getCodexHome(), "config.toml");
const getAuthPath = () => join(getCodexHome(), "auth.json");
const getModelsCachePath = () => join(getCodexHome(), "models_cache.json");

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";
const isMissingFileError = (error) => error?.code === "ENOENT";

// Codex 官方模型目录缓存（models_cache.json）：由 codex-app-server 从 OpenAI 服务器获取后写入本地。
// 包含每个模型的 supported_reasoning_levels 和 input_modalities，离线时可复用。
// 本模块只读该文件，绝不写回；实时模型目录优先通过插件宿主进程内的后端内存数据提供。
// 注意：该文件归 app-server 私有，一旦它写入了临时空文件、BOM 前缀或异常 JSON，
// 我们必须静默降级（返回 null）而不是抛错，以免影响 app-server 自身重新拉取。
const loadModelsCache = async () => {
  try {
    const raw = await readFile(getModelsCachePath(), "utf8");
    // 兼容空文件 / 原子写入留下的 0 字节文件 → 视为无缓存，等待 app-server 重写。
    const content = String(raw || "").replace(/^\uFEFF/, "").trim();
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
    const bySlug = new Map();
    for (const model of parsed.models) {
      if (!isRecord(model) || !model.slug) continue;
      bySlug.set(asString(model.slug), model);
    }
    return bySlug;
  } catch {
    return null;
  }
};
let modelsCacheMap = null;
let modelsCacheLoaded = false;
const getModelsCache = async (force = false) => {
  if (!force && modelsCacheLoaded) return modelsCacheMap;
  const loaded = await loadModelsCache();
  modelsCacheMap = loaded;
  modelsCacheLoaded = true;
  return loaded;
};

// 从后端实时模型（插件宿主进程内内存数据）提取模型能力信息。
// 后端通过 worker 从 app-server 拉取实时模型目录，与 configProvider 同进程，
// 因此可直接在内存中共享，无需写回 models_cache.json（该文件由 app-server 持有）。
const getModelCapabilitiesFromRealtime = (realtimeModels, modelId) => {
  if (!Array.isArray(realtimeModels)) return null;
  const found = realtimeModels.find((model) => isRecord(model) && asString(model.id) === modelId);
  if (!found) return null;
  const levels = Array.isArray(found.supportedThinkingLevels)
    ? found.supportedThinkingLevels.map((level) => asString(level)).filter(Boolean)
    : [];
  return {
    displayName: asString(found.name) || modelId,
    supportedThinkingLevels: levels,
    reasoning: levels.length > 0 || found.reasoning === true,
    imageInput: found.supportsImages === true,
  };
};

// 获取模型能力：优先使用实时内存模型，其次只读读取官方目录缓存（models_cache.json）。
const getModelCapabilities = async (modelId, realtimeModels) => {
  const fromRealtime = getModelCapabilitiesFromRealtime(realtimeModels, modelId);
  if (fromRealtime) return fromRealtime;
  return getModelCapabilitiesFromCache(modelId);
};

// 从 models_cache.json 条目提取模型能力信息
const getModelCapabilitiesFromCache = async (modelId) => {
  let cache = await getModelsCache();
  if (!cache) return null;
  let entry = cache.get(modelId);
  if (!entry) {
    // 文件可能已被 worker 同步更新，重新读取一次再判定，避免使用过期的内存缓存。
    cache = await getModelsCache(true);
    if (!cache) return null;
    entry = cache.get(modelId);
    if (!entry) return null;
  }
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels
        .map((level) => isRecord(level) ? asString(level.effort) : asString(level))
        .filter(Boolean)
    : [];
  const imageInput = Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image");
  return {
    displayName: asString(entry.display_name) || modelId,
    supportedThinkingLevels: levels,
    reasoning: levels.length > 0,
    imageInput,
  };
};

const parseJsonObject = (content, filePath) => {
  try {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) throw new Error("root value must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error?.message || String(error)}`);
  }
};

const readTextFile = async (filePath) => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
    throw error;
  }
};

const readJsonObject = async (filePath) => {
  try {
    return parseJsonObject(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
};

const writeTextFileAtomic = async (filePath, content) => {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const writeJsonObject = (filePath, value) =>
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);

const snapshotFile = async (filePath) => {
  try {
    return { filePath, existed: true, content: await readFile(filePath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { filePath, existed: false, content: "" };
    throw error;
  }
};

const restoreSnapshot = async (snapshot) => {
  if (snapshot.existed) {
    await writeTextFileAtomic(snapshot.filePath, snapshot.content);
  } else {
    await rm(snapshot.filePath, { force: true });
  }
};

const unquoteTomlValue = (rawValue) => {
  const value = rawValue.trim();
  if (!value) return "";
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) return "";
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  if (value.startsWith("'")) return value.match(/^'([^']*)'/)?.[1] || "";
  return value.split(/\s+#/)[0].trim();
};

const parseTomlKeyValue = (line) => {
  const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
  return match ? { key: match[1], value: unquoteTomlValue(match[2]) } : null;
};

const parseProviderSection = (line) => {
  const match = line.match(/^\s*\[model_providers\.(?:"((?:\\.|[^"\\])*)"|'([^']+)'|([^\]]+))\]\s*$/);
  if (!match) return "";
  if (match[1] !== undefined) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  return (match[2] || match[3] || "").trim();
};

const getTopLevelValue = (content, key) => {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) return "";
    if (!line || line.startsWith("#")) continue;
    const pair = parseTomlKeyValue(rawLine);
    if (pair?.key === key) return pair.value;
  }
  return "";
};

const escapeTomlString = (value) => JSON.stringify(value);
const tomlKey = (key) => /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeTomlString(key);
const providerSectionHeader = (providerId) => `[model_providers.${tomlKey(providerId)}]`;

const setTopLevelValue = (content, key, value) => {
  const lines = content ? content.split(/\r?\n/) : [];
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const scanEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const nextLine = `${key} = ${escapeTomlString(value)}`;
  for (let index = 0; index < scanEnd; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  lines.splice(firstSectionIndex === -1 ? lines.length : firstSectionIndex, 0, nextLine);
  return lines.join("\n");
};

const getFirstProviderSectionId = (content) => {
  for (const line of content.split(/\r?\n/)) {
    const providerId = parseProviderSection(line);
    if (providerId) return providerId;
  }
  return "";
};

const upsertProviderValue = (content, providerId, key, value) => {
  const lines = content ? content.split(/\r?\n/) : [];
  const nextLine = `${key} = ${escapeTomlString(value)}`;
  let start = lines.findIndex((line) => parseProviderSection(line) === providerId);
  if (start === -1) {
    const suffix = lines.length > 0 && lines.at(-1).trim() ? [""] : [];
    return [...lines, ...suffix, providerSectionHeader(providerId), nextLine, ""].join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  for (let index = start + 1; index < end; index += 1) {
    if (parseTomlKeyValue(lines[index])?.key === key) {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }
  let insertIndex = end;
  while (insertIndex > start + 1 && !lines[insertIndex - 1].trim()) insertIndex -= 1;
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
};

// 未保存前实时判定模型是否在官方目录（models_cache.json）中：
// 与 readProviderConfig 的内置判定规则保持一致，供配置弹窗输入 model-id 时即时判定。
export const lookupModel = async (modelId, realtimeModels) => {
  const id = asString(modelId);
  if (!id) return null;
  const capabilities = await getModelCapabilities(id, realtimeModels);
  if (!capabilities) return null;
  return {
    isBuiltin: true,
    name: capabilities.displayName || undefined,
    reasoning: capabilities.reasoning,
    imageInput: capabilities.imageInput,
    ...(capabilities.supportedThinkingLevels.length > 0
      ? { supportedThinkingLevels: capabilities.supportedThinkingLevels }
      : {}),
  };
};

// 收集所有已知的内置模型：实时内存模型 + 文件缓存模型。
// 这些模型会追加到 provider.models 末尾，让上层 mergeModelsWithConfiguredAgentModels
// 的 discoveredById Map 能按 id 命中 gpt-5.6-sol 等任何已存在于内置目录里的模型。
const collectAllBuiltinModels = async (realtimeModels) => {
  const byId = new Map();
  const toEntry = (id, cap) => ({
    id,
    name: cap.displayName,
    reasoning: cap.reasoning,
    imageInput: cap.imageInput,
    isBuiltin: true,
    hasThinkingLevels: false,
    ...(cap.supportedThinkingLevels.length > 0
      ? { supportedThinkingLevels: cap.supportedThinkingLevels }
      : {}),
  });
  if (Array.isArray(realtimeModels)) {
    for (const raw of realtimeModels) {
      const id = asString(raw?.id);
      if (!id || byId.has(id)) continue;
      const cap = getModelCapabilitiesFromRealtime(realtimeModels, id);
      if (!cap) continue;
      byId.set(id, toEntry(id, cap));
    }
  }
  const fileCache = await getModelsCache();
  if (fileCache) {
    for (const slug of fileCache.keys()) {
      if (byId.has(slug)) continue;
      const cap = await getModelCapabilitiesFromCache(slug);
      if (!cap) continue;
      byId.set(slug, toEntry(slug, cap));
    }
  }
  return byId;
};

export const readProviderConfig = async (realtimeModels) => {
  const [content, auth] = await Promise.all([
    readTextFile(getConfigPath()),
    readJsonObject(getAuthPath()),
  ]);
  const activeProviderId = getTopLevelValue(content, "model_provider") || undefined;
  const activeModelId = getTopLevelValue(content, "model") || DEFAULT_MODEL_ID;
  const providers = new Map();
  let currentProviderId = "";

  for (const rawLine of content.split(/\r?\n/)) {
    const providerSection = parseProviderSection(rawLine);
    if (providerSection) {
      currentProviderId = providerSection;
      providers.set(providerSection, {
        providerId: providerSection,
        displayName: providerSection,
        baseUrl: "",
        apiKey: asString(auth.OPENAI_API_KEY),
        endpoint: "responses",
        models: [],
      });
      continue;
    }
    if (!currentProviderId) continue;
    const provider = providers.get(currentProviderId);
    const pair = parseTomlKeyValue(rawLine);
    if (!provider || !pair) continue;
    if (pair.key === "name") provider.displayName = pair.value || currentProviderId;
    if (pair.key === "base_url") provider.baseUrl = pair.value;
    if (pair.key === "wire_api") provider.endpoint = pair.value === "responses" ? "responses" : "chat-completions";
  }

  if (activeProviderId && !providers.has(activeProviderId)) {
    providers.set(activeProviderId, {
      providerId: activeProviderId,
      displayName: activeProviderId,
      baseUrl: "",
      apiKey: asString(auth.OPENAI_API_KEY),
      endpoint: "responses",
      models: [],
    });
  }
  const allBuiltins = await collectAllBuiltinModels(realtimeModels);
  for (const provider of providers.values()) {
    provider.apiKey = asString(auth.OPENAI_API_KEY);
    // 1) 当前激活模型放在第一个（保持原本 activeModelId 的主位语义）
    const capabilities = await getModelCapabilities(activeModelId, realtimeModels);
    if (capabilities) {
      provider.models = [{
        id: activeModelId,
        name: capabilities.displayName,
        reasoning: capabilities.reasoning,
        imageInput: capabilities.imageInput,
        isBuiltin: true,
        hasThinkingLevels: false,
        ...(capabilities.supportedThinkingLevels.length > 0
          ? { supportedThinkingLevels: capabilities.supportedThinkingLevels }
          : {}),
      }];
    } else {
      // 不在官方目录中 → 自定义模型，允许用户配置能力
      provider.models = [{
        id: activeModelId,
        name: activeModelId,
        reasoning: true,
        imageInput: true,
        isBuiltin: false,
        hasThinkingLevels: true,
      }];
    }
    // 2) 把所有已知内置模型追加到末尾（包括 gpt-5.6-sol 这类新模型），
    //    让 discoveredById Map 能按 id 命中，判定为内置。
    for (const [id, builtin] of allBuiltins) {
      if (id === activeModelId) continue;
      provider.models.push(builtin);
    }
  }
  return { activeProviderId, providers: Array.from(providers.values()) };
};

export const activateProvider = async (provider) => {
  if (!isRecord(provider)) throw new Error("Codex provider configuration is invalid.");
  const baseUrl = asString(provider.baseUrl);
  const apiKey = asString(provider.apiKey);
  const selectedModel = asString(provider.models?.[0]?.id) || DEFAULT_MODEL_ID;
  if (!baseUrl) throw new Error("Codex provider base URL is empty.");
  if (!apiKey) throw new Error("Codex provider API key is empty.");

  const configPath = getConfigPath();
  const authPath = getAuthPath();
  const snapshots = await Promise.all([snapshotFile(configPath), snapshotFile(authPath)]);
  let content = snapshots[0].content;
  const auth = snapshots[1].existed ? parseJsonObject(snapshots[1].content, authPath) : {};
  const activeNativeProviderId = getTopLevelValue(content, "model_provider");
  const firstNativeProviderId = getFirstProviderSectionId(content);
  const targetProviderId = activeNativeProviderId || firstNativeProviderId || "openai";

  content = setTopLevelValue(content, "model_provider", targetProviderId);
  content = setTopLevelValue(content, "model", selectedModel);
  content = upsertProviderValue(content, targetProviderId, "base_url", baseUrl);
  content = upsertProviderValue(content, targetProviderId, "wire_api", provider.endpoint === "responses" ? "responses" : "chat");
  auth.OPENAI_API_KEY = apiKey;

  try {
    await writeTextFileAtomic(configPath, content.endsWith("\n") ? content : `${content}\n`);
    await writeJsonObject(authPath, auth);
    return { snapshots };
  } catch (error) {
    await Promise.allSettled(snapshots.map(restoreSnapshot));
    throw error;
  }
};

export const getDefaultThinkingLevel = async () => {
  const value = getTopLevelValue(await readTextFile(getConfigPath()), "model_reasoning_effort").toLowerCase();
  if (value === "none") return "off";
  return VALID_THINKING_LEVELS.has(value) ? value : DEFAULT_THINKING_LEVEL;
};
