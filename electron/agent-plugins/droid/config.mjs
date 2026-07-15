import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const getConfigPath = () => process.env.DROID_CONFIG_PATH || join(homedir(), ".factory", "settings.json");

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";
const isMissingFileError = (error) => isRecord(error) && error.code === "ENOENT";

const readJsonObject = async (filePath) => {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }

  try {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) throw new Error("configuration root must be a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse Droid config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const writeJsonObject = async (filePath, value) => {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
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

const sanitizeProviderId = (value, fallback) => {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
};

const uniqueProviderId = (baseId, usedIds) => {
  const normalizedBaseId = sanitizeProviderId(baseId, "custom");
  let providerId = normalizedBaseId;
  let index = 2;
  while (usedIds.has(providerId)) {
    providerId = `${normalizedBaseId}-${index}`;
    index += 1;
  }
  usedIds.add(providerId);
  return providerId;
};

const providerIdFromUrl = (baseUrl, fallback, usedIds) => {
  try {
    return uniqueProviderId(new URL(baseUrl).hostname.replace(/^api\./i, ""), usedIds);
  } catch {
    return uniqueProviderId(fallback, usedIds);
  }
};

const getManagedModelKey = (providerId, modelId) => `${providerId}\u0000${modelId}`;

export const getProviderType = (endpoint) => {
  if (endpoint === "responses") return "openai";
  if (endpoint === "anthropic-messages") return "anthropic";
  return "generic-chat-completion-api";
};

export const getProviderEndpoint = (provider) => {
  if (provider === "openai") return "responses";
  if (provider === "anthropic") return "anthropic-messages";
  return "chat-completions";
};

export const readProviderConfig = async () => {
  const config = await readJsonObject(getConfigPath());
  const customModels = Array.isArray(config.customModels) ? config.customModels : [];
  const groups = new Map();
  const usedIds = new Set();

  for (const model of customModels) {
    if (!isRecord(model) || model.hppManaged !== true) continue;
    const baseUrl = asString(model.baseUrl) || asString(model.baseURL);
    const apiKey = asString(model.apiKey);
    const providerType = asString(model.provider) || "generic-chat-completion-api";
    const declaredProviderId = asString(model.hppProviderId);
    const providerId = declaredProviderId || providerIdFromUrl(baseUrl, providerType, usedIds);
    if (declaredProviderId) usedIds.add(declaredProviderId);
    if (!groups.has(providerId)) {
      groups.set(providerId, {
        providerId,
        displayName: asString(model.hppProviderDisplayName) || providerId,
        baseUrl,
        apiKey,
        endpoint: getProviderEndpoint(providerType),
        models: [],
        nativeModelIds: new Set(),
      });
    }
    const group = groups.get(providerId);
    const modelId = asString(model.model) || asString(model.displayName);
    if (!group || !modelId || group.models.some((item) => item.id === modelId)) continue;
    group.models.push({
      id: modelId,
      name: asString(model.displayName) || modelId,
      reasoning: model.hppReasoning === true || model.reasoning === true || model.enableThinking === true,
      imageInput: model.noImageSupport !== true,
    });
    const nativeModelId = asString(model.id);
    if (nativeModelId) group.nativeModelIds.add(nativeModelId);
  }

  const activeModel = asString(isRecord(config.sessionDefaultSettings) ? config.sessionDefaultSettings.model : undefined);
  const providers = Array.from(groups.values()).map(({ nativeModelIds: _nativeModelIds, ...provider }) => provider);
  const activeProviderId = activeModel
    ? Array.from(groups.values()).find((provider) => provider.nativeModelIds.has(activeModel))?.providerId
    : undefined;
  return { activeProviderId, providers };
};

export const writeProviderConfig = async (state) => {
  const filePath = getConfigPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const existingCustomModels = Array.isArray(config.customModels) ? config.customModels : [];
  const unmanagedModels = existingCustomModels.filter((model) => !isRecord(model) || model.hppManaged !== true);
  const existingManagedModels = new Map();

  for (const model of existingCustomModels) {
    if (!isRecord(model) || model.hppManaged !== true) continue;
    const providerId = asString(model.hppProviderId);
    const modelId = asString(model.model);
    if (providerId && modelId) existingManagedModels.set(getManagedModelKey(providerId, modelId), model);
  }

  const managedModels = [];
  for (const provider of state.providers || []) {
    for (const model of provider.models || []) {
      const existing = existingManagedModels.get(getManagedModelKey(provider.providerId, model.id)) || {};
      const nativeModelId = asString(existing.id) || `custom:hpp:${sanitizeProviderId(provider.providerId, "provider")}:${sanitizeProviderId(model.id, "model")}`;
      managedModels.push({
        ...existing,
        hppManaged: true,
        hppProviderId: provider.providerId,
        hppProviderDisplayName: provider.displayName || provider.providerId,
        hppReasoning: model.reasoning === true,
        provider: getProviderType(provider.endpoint),
        model: model.id,
        id: nativeModelId,
        displayName: model.name || model.id,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        noImageSupport: model.imageInput !== true,
      });
    }
  }

  await writeJsonObject(filePath, {
    ...config,
    customModels: [...unmanagedModels, ...managedModels],
  });
  return { snapshots: [snapshot] };
};
