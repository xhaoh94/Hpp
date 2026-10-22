import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ENDPOINT_PACKAGES = {
  responses: "@ai-sdk/openai",
  "chat-completions": "@ai-sdk/openai-compatible",
  "anthropic-messages": "@ai-sdk/anthropic",
};

// OpenCode 2.x 的 provider 声明（providers.*）用 package/settings，包名也换到
// @opencode/ai/providers/*。读取时按后缀匹配，避免包名细微调整导致渠道丢失。
const ENDPOINT_PACKAGES_V2 = {
  responses: "@opencode/ai/providers/openai",
  "chat-completions": "@opencode/ai/providers/openai-compatible",
  "anthropic-messages": "@opencode/ai/providers/anthropic",
};

let cliVersionMajorPromise;

/** 探测 opencode CLI 主版本：>=2 时需要写 V2 配置结构。 */
const detectCliVersionMajor = () => {
  if (!cliVersionMajorPromise) {
    cliVersionMajorPromise = new Promise((resolve) => {
      const tryExec = (command, args) => new Promise((res) => {
        try {
          execFile(command, args, { timeout: 3000, windowsHide: true }, (error, stdout) => {
            if (error) return res("");
            res(String(stdout || ""));
          });
        } catch {
          res("");
        }
      });
      (async () => {
        // npm/.cmd shim 在 Windows 上不能直接被 execFile 执行，走 cmd.exe 兜底。
        let stdout = await tryExec("opencode", ["--version"]);
        if (!stdout && process.platform === "win32") {
          const comspec = process.env.ComSpec || "cmd.exe";
          stdout = await tryExec(comspec, ["/d", "/s", "/c", "opencode --version"]);
        }
        if (!stdout && process.platform === "win32") {
          const comspec = process.env.ComSpec || "cmd.exe";
          stdout = await tryExec(comspec, ["/d", "/s", "/c", "opencode.cmd --version"]);
        }
        const match = stdout.match(/v?(\d+)/);
        resolve(match ? Number(match[1]) : null);
      })();
    });
  }
  return cliVersionMajorPromise;
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

const normalizeThinkingLevels = (values) => {
  if (!Array.isArray(values)) return [];
  const levels = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase() === "none" ? "off" : value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    levels.push(normalized);
  }
  return levels;
};

const getModelThinkingLevels = (value) => {
  if (Array.isArray(value.hppSupportedThinkingLevels)) {
    return normalizeThinkingLevels(value.hppSupportedThinkingLevels);
  }
  if (!isRecord(value.variants)) return undefined;
  return normalizeThinkingLevels(Object.entries(value.variants).flatMap(([level, options]) =>
    !isRecord(options) || options.disabled !== true ? [level] : []
  ));
};

const normalizeModel = (value, fallbackId) => {
  if (!isRecord(value)) {
    const id = asString(fallbackId) || asString(value);
    return id ? { id, name: id, reasoning: false, imageInput: false, isBuiltin: false, hasThinkingLevels: false } : null;
  }
  const id = asString(value.id) || asString(value.model) || asString(value.name) || asString(fallbackId);
  if (!id) return null;
  const supportedThinkingLevels = getModelThinkingLevels(value);
  const reasoning = value.reasoning === true;
  const imageInput = modelSupportsImages(value);
  // OpenCode 没有内置 catalog，所有模型均为用户配置的自定义模型。
  // 有显式档位声明的模型不需要用户再配置；有 reasoning 但无档位的允许用户配置。
  const hasExplicitLevels = Array.isArray(supportedThinkingLevels) && supportedThinkingLevels.length > 0;
  return {
    id,
    name: asString(value.name) || asString(value.displayName) || id,
    reasoning,
    imageInput,
    isBuiltin: false,
    hasThinkingLevels: reasoning && !hasExplicitLevels,
    ...(hasExplicitLevels ? { supportedThinkingLevels } : {}),
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
    const supportedThinkingLevels = normalizeThinkingLevels(model.supportedThinkingLevels);
    const nextModel = {
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
    // Keep Hpp's explicit selection separate from native variant options so
    // advanced OpenCode variant configuration remains lossless.
    nextModel.hppSupportedThinkingLevels = supportedThinkingLevels;
    models[model.id] = nextModel;
  }
  return {
    ...existing,
    npm: ENDPOINT_PACKAGES[provider.endpoint] || ENDPOINT_PACKAGES["chat-completions"],
    name: provider.displayName || provider.providerId,
    options,
    models,
  };
};

export const getProviderEndpointV2 = (packageName) => {
  const normalized = asString(packageName);
  if (!normalized) return undefined;
  return Object.entries(ENDPOINT_PACKAGES_V2).find(([, name]) => (
    normalized === name || normalized.endsWith(`/${name.split("/").pop()}`)
  ))?.[0];
};

const isManagedProviderV2 = (value) => isRecord(value) && !!getProviderEndpointV2(value.package);

const buildProviderModels = (provider, rawExistingModels) => {
  const models = {};
  for (const model of provider.models || []) {
    const existingModel = isRecord(rawExistingModels) && isRecord(rawExistingModels[model.id])
      ? rawExistingModels[model.id]
      : {};
    const existingModalities = isRecord(existingModel.modalities) ? existingModel.modalities : {};
    const supportedThinkingLevels = normalizeThinkingLevels(model.supportedThinkingLevels);
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
      hppSupportedThinkingLevels: supportedThinkingLevels,
    };
  }
  return models;
};

/** V2 provider 条目：providers.<id> = { name, package, settings, models }。 */
export const toProviderConfigV2 = (provider, existingValue = {}) => {
  const existing = isRecord(existingValue) ? existingValue : {};
  const existingSettings = isRecord(existing.settings) ? existing.settings : {};
  const settings = { ...existingSettings, baseURL: provider.baseUrl };
  if (asString(provider.apiKey)) settings.apiKey = provider.apiKey;
  else delete settings.apiKey;
  return {
    ...existing,
    package: ENDPOINT_PACKAGES_V2[provider.endpoint] || ENDPOINT_PACKAGES_V2["chat-completions"],
    name: provider.displayName || provider.providerId,
    settings,
    models: buildProviderModels(provider, existing.models),
  };
};

export const readProviderConfig = async () => {
  const config = await readJsonObject(getConfigPath());
  const v1Providers = isRecord(config.provider) ? config.provider : {};
  const v2Providers = isRecord(config.providers) ? config.providers : {};
  // V2 的 providers.* 优先；同一 id 在两种结构里都存在时以 V2 为准。
  const entries = [
    ...Object.entries(v2Providers).map(([providerId, value]) => ({ providerId, value, shape: "v2" })),
    ...Object.entries(v1Providers)
      .filter(([providerId]) => !isRecord(v2Providers[providerId]))
      .map(([providerId, value]) => ({ providerId, value, shape: "v1" })),
  ];
  const providers = entries.flatMap(({ providerId, value, shape }) => {
    if (!isRecord(value)) return [];
    const endpoint = shape === "v2" ? getProviderEndpointV2(value.package) : getProviderEndpoint(value.npm);
    if (!endpoint) return [];
    const options = isRecord(shape === "v2" ? value.settings : value.options)
      ? (shape === "v2" ? value.settings : value.options)
      : {};
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
  // 写入结构跟随配置文件已有形状：已有 providers 段说明是 V2 配置；已有 provider
  // 段说明是 V1 配置（V2 迁移期仍接受这种形状），不强行改写。全新配置才按 CLI
  // 主版本决定，避免用户升级 OpenCode 后渠道配置被整体迁移。
  const hasV1Providers = isRecord(config.provider) && Object.keys(config.provider).length > 0;
  const hasV2Providers = isRecord(config.providers) && Object.keys(config.providers).length > 0;
  const cliMajor = hasV1Providers || hasV2Providers ? null : await detectCliVersionMajor();
  const useV2 = hasV2Providers || (!hasV1Providers && cliMajor !== null && cliMajor >= 2);

  if (useV2) {
    const existingProviders = isRecord(config.providers) ? config.providers : {};
    const providers = {};
    for (const item of state.providers || []) {
      providers[item.providerId] = toProviderConfigV2(item, existingProviders[item.providerId]);
    }
    for (const [providerId, value] of Object.entries(existingProviders)) {
      if (!isManagedProviderV2(value)) providers[providerId] = value;
    }
    await writeJsonObject(filePath, { ...config, providers });
    return { snapshots: [snapshot] };
  }

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
