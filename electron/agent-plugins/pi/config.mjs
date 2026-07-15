import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const normalizeModel = (value) => {
  if (!isRecord(value)) return null;
  const id = asString(value.id) || asString(value.model) || asString(value.name);
  if (!id) return null;
  return {
    id,
    name: asString(value.name) || id,
    reasoning: value.reasoning === true,
    imageInput: Array.isArray(value.input) && value.input.includes("image"),
  };
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
    models: (provider.models || []).map((model) => ({
      ...(existingModelsById.get(model.id) || {}),
      id: model.id,
      name: model.name || model.id,
      reasoning: model.reasoning === true,
      input: model.imageInput ? ["text", "image"] : ["text"],
    })),
  };
  if (asString(provider.apiKey)) nextProvider.apiKey = provider.apiKey;
  else delete nextProvider.apiKey;
  return nextProvider;
};

export const readProviderConfig = async () => {
  const config = await readJsonObject(getConfigPath());
  const providersRecord = isRecord(config.providers) ? config.providers : {};
  const providers = Object.entries(providersRecord).flatMap(([providerId, value]) => {
    if (!isManagedProvider(value)) return [];
    const endpoint = getProviderEndpoint(value.api);
    if (!endpoint) return [];
    const models = Array.isArray(value.models) ? value.models.map(normalizeModel).filter(Boolean) : [];
    return [{
      providerId,
      displayName: asString(value.name) || providerId,
      baseUrl: asString(value.baseUrl) || asString(value.baseURL) || asString(value.url),
      apiKey: asString(value.apiKey) || asString(value.api_key),
      endpoint,
      models,
    }];
  });
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
