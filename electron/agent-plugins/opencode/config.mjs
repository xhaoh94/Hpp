import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ENDPOINT_PACKAGES = {
  responses: "@ai-sdk/openai",
  "chat-completions": "@ai-sdk/openai-compatible",
  "anthropic-messages": "@ai-sdk/anthropic",
};

export const getConfigPath = () => {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
  const configDir = join(homedir(), ".config", "opencode");
  const jsonPath = join(configDir, "opencode.json");
  const jsoncPath = join(configDir, "opencode.jsonc");
  if (existsSync(jsonPath)) return jsonPath;
  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
};

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";

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
  if (!isRecord(parsed)) throw new Error(`OpenCode config must contain a JSON object: ${filePath}`);
  return parsed;
};

const readJsonObject = async (filePath) => {
  try {
    return parseJsonObject(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Failed to parse OpenCode config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
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
  } catch {
    return { filePath, existed: false, content: "" };
  }
};

const modelSupportsImages = (value) => {
  if (value.imageInput === true || value.supportsImages === true || value.attachment === true) return true;
  if (Array.isArray(value.input) && value.input.includes("image")) return true;
  const modalities = isRecord(value.modalities) ? value.modalities : {};
  return Array.isArray(modalities.input) && modalities.input.includes("image");
};

const normalizeModel = (value, fallbackId) => {
  if (!isRecord(value)) {
    const id = asString(fallbackId) || asString(value);
    return id ? { id, name: id, reasoning: false, imageInput: false } : null;
  }
  const id = asString(value.id) || asString(value.model) || asString(value.name) || asString(fallbackId);
  if (!id) return null;
  return {
    id,
    name: asString(value.name) || asString(value.displayName) || id,
    reasoning: value.reasoning === true,
    imageInput: modelSupportsImages(value),
  };
};

const parseModels = (rawModels) => {
  if (Array.isArray(rawModels)) return rawModels.map((model) => normalizeModel(model)).filter(Boolean);
  if (!isRecord(rawModels)) return [];
  return Object.entries(rawModels).map(([modelId, value]) => normalizeModel(value, modelId)).filter(Boolean);
};

export const getProviderEndpoint = (npmPackage) => {
  const normalized = asString(npmPackage);
  if (!normalized || normalized === ENDPOINT_PACKAGES["chat-completions"]) return "chat-completions";
  return Object.entries(ENDPOINT_PACKAGES).find(([, packageName]) => packageName === normalized)?.[0];
};

const isManagedProvider = (value) => isRecord(value) && !!getProviderEndpoint(value.npm);

export const toProviderConfig = (provider, existingValue = {}) => {
  const existing = isRecord(existingValue) ? existingValue : {};
  const existingOptions = isRecord(existing.options) ? existing.options : {};
  const options = { ...existingOptions, baseURL: provider.baseUrl };
  if (asString(provider.apiKey)) options.apiKey = provider.apiKey;
  else delete options.apiKey;

  const existingModels = isRecord(existing.models) ? existing.models : {};
  const models = {};
  for (const model of provider.models || []) {
    const existingModel = isRecord(existingModels[model.id]) ? existingModels[model.id] : {};
    const existingModalities = isRecord(existingModel.modalities) ? existingModel.modalities : {};
    models[model.id] = {
      ...existingModel,
      name: model.name || model.id,
      reasoning: model.reasoning === true,
      attachment: model.imageInput === true,
      modalities: {
        ...existingModalities,
        input: model.imageInput ? ["text", "image"] : ["text"],
        output: Array.isArray(existingModalities.output) ? existingModalities.output : ["text"],
      },
    };
  }
  return {
    ...existing,
    npm: ENDPOINT_PACKAGES[provider.endpoint] || ENDPOINT_PACKAGES["chat-completions"],
    name: provider.displayName || provider.providerId,
    options,
    models,
  };
};

export const readProviderConfig = async () => {
  const config = await readJsonObject(getConfigPath());
  const providersRecord = isRecord(config.provider) ? config.provider : {};
  const providers = Object.entries(providersRecord).flatMap(([providerId, value]) => {
    if (!isRecord(value)) return [];
    const endpoint = getProviderEndpoint(value.npm);
    if (!endpoint) return [];
    const options = isRecord(value.options) ? value.options : {};
    return [{
      providerId,
      displayName: asString(value.name) || providerId,
      baseUrl: asString(options.baseURL) || asString(options.baseUrl) || asString(value.baseURL) || asString(value.baseUrl),
      apiKey: asString(options.apiKey) || asString(value.apiKey),
      endpoint,
      models: parseModels(value.models),
    }];
  });
  const configuredModel = asString(config.model);
  const activeProviderId = configuredModel.includes("/")
    ? configuredModel.split("/")[0]
    : asString(config.providerID) || asString(config.providerId) || undefined;
  return { activeProviderId, providers };
};

export const writeProviderConfig = async (state) => {
  const filePath = getConfigPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const existingProviders = isRecord(config.provider) ? config.provider : {};
  const provider = {};
  for (const item of state.providers || []) {
    provider[item.providerId] = toProviderConfig(item, existingProviders[item.providerId]);
  }
  for (const [providerId, value] of Object.entries(existingProviders)) {
    if (!isManagedProvider(value)) provider[providerId] = value;
  }
  await writeJsonObject(filePath, { ...config, provider });
  return { snapshots: [snapshot] };
};
