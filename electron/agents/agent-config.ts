import { app } from "electron";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

export interface AgentCustomModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  imageInput: boolean;
}

export interface AgentProviderConfig {
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  models: AgentCustomModelConfig[];
  hppManaged?: boolean;
}

export interface AgentConfigState {
  activeProviderId?: string;
  providers: AgentProviderConfig[];
}

export interface AgentConfigResult {
  success: boolean;
  error?: string;
  config?: AgentConfigState;
}

export interface FileSnapshot {
  filePath: string;
  existed: boolean;
  content: string;
}

type JsonRecord = Record<string, any>;

const SUPPORTED_CONFIG_AGENTS = new Set(["codex", "pi", "droid", "opencode"]);
const SETTINGS_KEY = "agentConfigs";
const CODEX_FALLBACK_MODEL_ID = "gpt-5.5";

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getDataDir() {
  return join(app.getPath("userData"), "hpp-data");
}

function getSettingsPath() {
  return join(getDataDir(), "settings.json");
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function readJsonObject(filePath: string): Promise<JsonRecord> {
  try {
    const content = (await readFile(filePath, "utf-8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonObject(filePath: string, value: JsonRecord) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readSettings(): Promise<JsonRecord> {
  return readJsonObject(getSettingsPath());
}

async function writeSettings(settings: JsonRecord) {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function normalizeModel(value: unknown): AgentCustomModelConfig | null {
  if (!isRecord(value)) return null;
  const id = String(value.id || "").trim();
  if (!id) return null;
  const name = String(value.name || id).trim() || id;
  return {
    id,
    name,
    reasoning: value.reasoning === true,
    imageInput: value.imageInput === true,
  };
}

function normalizeProvider(value: unknown): AgentProviderConfig | null {
  if (!isRecord(value)) return null;
  const providerId = String(value.providerId || "").trim();
  if (!providerId) return null;
  const displayName = String(value.displayName || providerId).trim() || providerId;
  const baseUrl = String(value.baseUrl || "").trim();
  const apiKey = String(value.apiKey || "").trim();
  const models = Array.isArray(value.models)
    ? value.models.map(normalizeModel).filter((model): model is AgentCustomModelConfig => !!model)
    : [];
  return { providerId, displayName, baseUrl, apiKey, models, hppManaged: value.hppManaged === true };
}

function getOriginalProviderId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const originalProviderId = String(value.originalProviderId || "").trim();
  return originalProviderId || undefined;
}

function normalizeState(value: unknown): AgentConfigState {
  const record = isRecord(value) ? value : {};
  const providers = Array.isArray(record.providers)
    ? record.providers.map(normalizeProvider).filter((provider): provider is AgentProviderConfig => !!provider)
    : [];
  const activeProviderId = typeof record.activeProviderId === "string" ? record.activeProviderId : undefined;
  return {
    activeProviderId: activeProviderId && providers.some((provider) => provider.providerId === activeProviderId)
      ? activeProviderId
      : undefined,
    providers,
  };
}

async function readSavedAgentConfigState(agentId: string): Promise<AgentConfigState> {
  const settings = await readSettings();
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  return normalizeState(allConfigs[agentId]);
}

async function readSavedAgentConfigEntry(agentId: string): Promise<{ exists: boolean; state: AgentConfigState }> {
  const settings = await readSettings();
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  return {
    exists: Object.prototype.hasOwnProperty.call(allConfigs, agentId),
    state: normalizeState(allConfigs[agentId]),
  };
}

function isSameCodexNativeProvider(provider: AgentProviderConfig, nativeProvider: AgentProviderConfig) {
  return provider.providerId === nativeProvider.providerId
    && provider.displayName === nativeProvider.displayName
    && provider.baseUrl === nativeProvider.baseUrl;
}

function isLegacyCodexNativeProvider(
  provider: AgentProviderConfig,
  nativeProviders: AgentProviderConfig[],
  savedActiveProviderId?: string
) {
  if (provider.hppManaged === true) return false;
  if (
    provider.providerId === "custom"
    && provider.displayName === "custom"
    && provider.providerId !== savedActiveProviderId
  ) {
    return true;
  }

  const nativeProvider = nativeProviders.find((item) => item.providerId === provider.providerId);
  return !!nativeProvider
    && provider.providerId !== savedActiveProviderId
    && isSameCodexNativeProvider(provider, nativeProvider);
}

async function readSavedCodexConfigState(): Promise<AgentConfigState> {
  const savedEntry = await readSavedAgentConfigEntry("codex");
  if (!savedEntry.exists) {
    const native = await readCodexNativeConfigState();
    const nativeProvider = native.providers.find((provider) => provider.providerId === native.activeProviderId)
      || native.providers[0];
    const nextState = nativeProvider
      ? {
          activeProviderId: nativeProvider.providerId,
          providers: [{ ...nativeProvider, hppManaged: true }],
        }
      : { providers: [] };
    await writeAgentConfigState("codex", nextState);
    return nextState;
  }

  const saved = savedEntry.state;
  if (saved.providers.every((provider) => provider.hppManaged === true)) return saved;

  const native = await readCodexNativeConfigState();
  const providers = saved.providers
    .filter((provider) => !isLegacyCodexNativeProvider(provider, native.providers, saved.activeProviderId))
    .map((provider) => ({ ...provider, hppManaged: true }));
  const nextState = {
    activeProviderId: saved.activeProviderId && providers.some((provider) => provider.providerId === saved.activeProviderId)
      ? saved.activeProviderId
      : undefined,
    providers,
  };

  await writeAgentConfigState("codex", nextState);
  return nextState;
}

async function writeAgentConfigState(agentId: string, state: AgentConfigState) {
  const settings = await readSettings();
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  settings[SETTINGS_KEY] = {
    ...allConfigs,
    [agentId]: state,
  };
  await writeSettings(settings);
}

function ensureSupportedAgent(agentId: string) {
  if (!SUPPORTED_CONFIG_AGENTS.has(agentId)) {
    throw new Error("当前 Agent 暂不支持自定义渠道配置。");
  }
}

function validateProviderConfig(provider: AgentProviderConfig) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(provider.providerId)) {
    throw new Error("渠道 ID 只能包含字母、数字、点、下划线、冒号和短横线。");
  }
  if (!provider.baseUrl) throw new Error("请填写渠道 URL。");
  if (!provider.apiKey) throw new Error("请填写 sk-key。");
  if (provider.models.length === 0) throw new Error("至少需要添加一个模型。");
  for (const model of provider.models) {
    if (!model.id.trim()) throw new Error("模型 ID 不能为空。");
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function mergeModels(saved: AgentCustomModelConfig[], native: AgentCustomModelConfig[]) {
  return uniqueById([
    ...saved.map((model) => ({ ...model })),
    ...native.map((model) => ({ ...model })),
  ]);
}

function sanitizeProviderId(value: string, fallback: string) {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function uniqueProviderId(baseId: string, usedIds: Set<string>) {
  let providerId = sanitizeProviderId(baseId, "custom");
  let index = 2;
  while (usedIds.has(providerId)) {
    providerId = `${sanitizeProviderId(baseId, "custom")}-${index}`;
    index += 1;
  }
  usedIds.add(providerId);
  return providerId;
}

function providerIdFromUrl(baseUrl: string, fallback: string, usedIds: Set<string>) {
  try {
    const url = new URL(baseUrl);
    return uniqueProviderId(url.hostname.replace(/^api\./i, ""), usedIds);
  } catch {
    return uniqueProviderId(fallback, usedIds);
  }
}

function modelSupportsImages(value: JsonRecord) {
  if (value.imageInput === true || value.supportsImages === true || value.attachment === true) return true;
  if (Array.isArray(value.input) && value.input.includes("image")) return true;
  const modalities = isRecord(value.modalities) ? value.modalities : {};
  return Array.isArray(modalities.input) && modalities.input.includes("image");
}

function normalizeNativeModel(value: unknown, fallbackId?: string): AgentCustomModelConfig | null {
  if (!isRecord(value)) {
    const id = String(fallbackId || value || "").trim();
    return id ? { id, name: id, reasoning: false, imageInput: false } : null;
  }
  const id = asString(value.id) || asString(value.model) || asString(value.name) || fallbackId || "";
  if (!id) return null;
  return {
    id,
    name: asString(value.name) || asString(value.displayName) || id,
    reasoning: value.reasoning === true,
    imageInput: modelSupportsImages(value),
  };
}

function getPiModelsPath() {
  return join(homedir(), ".pi", "agent", "models.json");
}

function getDroidSettingsPath() {
  return join(homedir(), ".factory", "settings.json");
}

export function getOpenCodeConfigPath() {
  return process.env.OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json");
}

function getCodexHomeDir() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function getCodexConfigPath() {
  return join(getCodexHomeDir(), "config.toml");
}

function getCodexAuthPath() {
  return join(getCodexHomeDir(), "auth.json");
}

async function readPiNativeConfigState(): Promise<AgentConfigState> {
  const config = await readJsonObject(getPiModelsPath());
  const providersRecord = isRecord(config.providers) ? config.providers : {};
  const providers: AgentProviderConfig[] = [];

  for (const [providerId, value] of Object.entries(providersRecord)) {
    if (!isRecord(value)) continue;
    const models = Array.isArray(value.models)
      ? value.models.map((model) => normalizeNativeModel(model)).filter((model): model is AgentCustomModelConfig => !!model)
      : [];
    providers.push({
      providerId,
      displayName: asString(value.name) || providerId,
      baseUrl: asString(value.baseUrl) || asString(value.baseURL) || asString(value.url),
      apiKey: asString(value.apiKey) || asString(value.api_key),
      models,
    });
  }

  return {
    activeProviderId: asString(config.activeProviderId) || asString(config.activeProvider),
    providers,
  };
}

async function readDroidNativeConfigState(): Promise<AgentConfigState> {
  const config = await readJsonObject(getDroidSettingsPath());
  const customModels = Array.isArray(config.customModels) ? config.customModels : [];
  const groups = new Map<string, AgentProviderConfig>();
  const keyToProviderId = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const model of customModels) {
    if (!isRecord(model)) continue;
    const baseUrl = asString(model.baseUrl) || asString(model.baseURL);
    const apiKey = asString(model.apiKey);
    const providerName = asString(model.hppProviderId) || asString(model.provider) || "custom";
    const groupKey = asString(model.hppProviderId) || `${providerName}|${baseUrl}|${apiKey}`;
    let providerId = keyToProviderId.get(groupKey);
    if (!providerId) {
      providerId = asString(model.hppProviderId) || providerIdFromUrl(baseUrl, providerName, usedIds);
      keyToProviderId.set(groupKey, providerId);
      groups.set(providerId, {
        providerId,
        displayName: asString(model.hppProviderId) || providerName || providerId,
        baseUrl,
        apiKey,
        models: [],
      });
    }
    const group = groups.get(providerId);
    if (!group) continue;
    const modelId = asString(model.model) || asString(model.id) || asString(model.displayName);
    if (!modelId) continue;
    group.models.push({
      id: modelId,
      name: asString(model.displayName) || modelId,
      reasoning: model.reasoning === true,
      imageInput: model.noImageSupport !== true,
    });
  }

  const activeModel = asString(isRecord(config.sessionDefaultSettings) ? config.sessionDefaultSettings.model : undefined)
    .replace(/^custom:/, "");
  const providers = Array.from(groups.values()).map((provider) => ({
    ...provider,
    models: uniqueById(provider.models),
  }));
  const activeProvider = activeModel
    ? providers.find((provider) => provider.models.some((model) => model.id === activeModel))?.providerId
    : undefined;

  return { activeProviderId: activeProvider, providers };
}

function parseOpenCodeModels(rawModels: unknown): AgentCustomModelConfig[] {
  if (Array.isArray(rawModels)) {
    return rawModels
      .map((model) => normalizeNativeModel(model))
      .filter((model): model is AgentCustomModelConfig => !!model);
  }
  if (!isRecord(rawModels)) return [];
  return Object.entries(rawModels)
    .map(([modelId, value]) => normalizeNativeModel(value, modelId))
    .filter((model): model is AgentCustomModelConfig => !!model);
}

async function readOpenCodeNativeConfigState(): Promise<AgentConfigState> {
  const config = await readJsonObject(getOpenCodeConfigPath());
  const providersRecord = isRecord(config.provider) ? config.provider : {};
  const providers: AgentProviderConfig[] = [];

  for (const [providerId, value] of Object.entries(providersRecord)) {
    if (!isRecord(value)) continue;
    const options = isRecord(value.options) ? value.options : {};
    providers.push({
      providerId,
      displayName: asString(value.name) || providerId,
      baseUrl: asString(options.baseURL) || asString(options.baseUrl) || asString(value.baseURL) || asString(value.baseUrl),
      apiKey: asString(options.apiKey) || asString(value.apiKey),
      models: parseOpenCodeModels(value.models),
    });
  }

  const configuredModel = asString(config.model);
  const activeProviderId = configuredModel.includes("/")
    ? configuredModel.split("/")[0]
    : asString(config.providerID) || asString(config.providerId);

  return { activeProviderId, providers };
}

function unquoteTomlValue(rawValue: string) {
  const value = rawValue.trim();
  if (!value) return "";
  if (value.startsWith("\"")) {
    const match = value.match(/^"((?:\\.|[^"\\])*)"/);
    if (!match) return "";
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'([^']*)'/);
    return match ? match[1] : "";
  }
  return value.split(/\s+#/)[0].trim();
}

function parseTomlKeyValue(line: string): { key: string; value: string } | null {
  const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
  if (!match) return null;
  return { key: match[1], value: unquoteTomlValue(match[2]) };
}

function unescapeTomlKey(rawKey: string) {
  const key = rawKey.trim();
  if (key.startsWith("\"") && key.endsWith("\"")) {
    try {
      return JSON.parse(key);
    } catch {
      return key.slice(1, -1);
    }
  }
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  return key;
}

function parseCodexProviderSection(line: string) {
  const match = line.match(/^\s*\[\s*model_providers\.(.+?)\s*\]\s*$/);
  return match ? unescapeTomlKey(match[1]) : null;
}

async function readCodexNativeConfigState(): Promise<AgentConfigState> {
  const content = await readTextFile(getCodexConfigPath());
  const auth = await readJsonObject(getCodexAuthPath());
  const providers = new Map<string, AgentProviderConfig>();
  let activeProviderId = "";
  let activeModelId = "";
  let currentProviderId: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const providerSection = parseCodexProviderSection(line);
    if (providerSection) {
      currentProviderId = providerSection;
      providers.set(providerSection, {
        providerId: providerSection,
        displayName: providerSection,
        baseUrl: "",
        apiKey: asString(auth.OPENAI_API_KEY),
        models: [],
      });
      continue;
    }
    if (line.startsWith("[")) {
      currentProviderId = null;
      continue;
    }

    const pair = parseTomlKeyValue(rawLine);
    if (!pair) continue;
    if (!currentProviderId) {
      if (pair.key === "model_provider") activeProviderId = pair.value;
      if (pair.key === "model") activeModelId = pair.value;
      continue;
    }

    const provider = providers.get(currentProviderId);
    if (!provider) continue;
    if (pair.key === "name") provider.displayName = pair.value || currentProviderId;
    if (pair.key === "base_url") provider.baseUrl = pair.value;
  }

  if (activeProviderId && !providers.has(activeProviderId)) {
    providers.set(activeProviderId, {
      providerId: activeProviderId,
      displayName: activeProviderId,
      baseUrl: "",
      apiKey: asString(auth.OPENAI_API_KEY),
      models: [],
    });
  }

  const modelId = activeModelId || CODEX_FALLBACK_MODEL_ID;
  const modelDefaults: AgentCustomModelConfig[] = [
    { id: modelId, name: modelId, reasoning: true, imageInput: true },
  ];

  for (const provider of providers.values()) {
    provider.apiKey = asString(auth.OPENAI_API_KEY);
    provider.models = provider.models.length > 0 ? mergeModels(modelDefaults, provider.models) : modelDefaults;
  }

  return { activeProviderId, providers: Array.from(providers.values()) };
}

async function readNativeAgentConfigState(agentId: string): Promise<AgentConfigState> {
  if (agentId === "codex") return readCodexNativeConfigState();
  if (agentId === "pi") return readPiNativeConfigState();
  if (agentId === "droid") return readDroidNativeConfigState();
  if (agentId === "opencode") return readOpenCodeNativeConfigState();
  return { providers: [] };
}

async function readCurrentAgentConfigState(agentId: string): Promise<AgentConfigState> {
  return agentId === "codex"
    ? readSavedCodexConfigState()
    : readNativeAgentConfigState(agentId);
}

export async function listAgentConfig(agentId: string): Promise<AgentConfigResult> {
  try {
    if (!SUPPORTED_CONFIG_AGENTS.has(agentId)) {
      return { success: true, config: { providers: [] } };
    }
    return { success: true, config: await readCurrentAgentConfigState(agentId) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function saveAgentProviderConfig(agentId: string, providerValue: unknown): Promise<AgentConfigResult> {
  try {
    ensureSupportedAgent(agentId);
    const normalizedProvider = normalizeProvider(providerValue);
    if (!normalizedProvider) throw new Error("渠道配置无效。");
    const provider = agentId === "codex"
      ? { ...normalizedProvider, hppManaged: true }
      : normalizedProvider;
    validateProviderConfig(provider);
    const originalProviderId = getOriginalProviderId(providerValue);

    const state = await readCurrentAgentConfigState(agentId);
    const providers = state.providers.filter((item) =>
      item.providerId !== provider.providerId && item.providerId !== originalProviderId
    );
    providers.push(provider);
    const nextState = {
      activeProviderId: state.activeProviderId === originalProviderId ? provider.providerId : state.activeProviderId,
      providers,
    };

    if (agentId === "codex") {
      await writeAgentConfigState(agentId, nextState);
    } else {
      await writeNativeAgentConfig(agentId, nextState);
    }

    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteAgentProviderConfig(agentId: string, providerId: string): Promise<AgentConfigResult> {
  try {
    ensureSupportedAgent(agentId);
    const state = agentId === "codex"
      ? await readSavedCodexConfigState()
      : await readNativeAgentConfigState(agentId);
    const nextProviders = state.providers.filter((provider) => provider.providerId !== providerId);
    const nextState = {
      activeProviderId: state.activeProviderId === providerId ? undefined : state.activeProviderId,
      providers: nextProviders,
    };
    if (agentId === "codex") {
      await writeAgentConfigState(agentId, nextState);
    } else {
      await writeNativeAgentConfig(agentId, nextState);
    }
    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setActiveAgentProviderConfig(agentId: string, providerId: string): Promise<AgentConfigState> {
  if (agentId !== "codex") {
    throw new Error("只有 Codex 需要启用渠道。");
  }
  const state = await readSavedCodexConfigState();
  if (!state.providers.some((provider) => provider.providerId === providerId)) {
    throw new Error("未找到要启用的渠道。");
  }
  const nextState = { ...state, activeProviderId: providerId };
  await writeAgentConfigState(agentId, nextState);
  return nextState;
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  if (!existsSync(filePath)) return { filePath, existed: false, content: "" };
  return { filePath, existed: true, content: await readFile(filePath, "utf-8") };
}

export async function restoreNativeConfigSnapshot(snapshot: FileSnapshot) {
  if (snapshot.existed) {
    await mkdir(dirname(snapshot.filePath), { recursive: true });
    await writeFile(snapshot.filePath, snapshot.content, "utf-8");
  } else {
    await rm(snapshot.filePath, { force: true });
  }
}

export async function restoreNativeConfigSnapshots(snapshots: FileSnapshot[]) {
  for (const snapshot of snapshots) {
    await restoreNativeConfigSnapshot(snapshot);
  }
}

function managedProviderIds(state: AgentConfigState) {
  return new Set(state.providers.map((provider) => provider.providerId));
}

function toPiProviderConfig(provider: AgentProviderConfig, existingProvider: JsonRecord = {}) {
  return {
    ...existingProvider,
    baseUrl: provider.baseUrl,
    api: existingProvider.api || "openai-completions",
    apiKey: provider.apiKey,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: !!model.reasoning,
      input: model.imageInput ? ["text", "image"] : ["text"],
    })),
  };
}

async function writePiNativeConfig(state: AgentConfigState, provider: AgentProviderConfig): Promise<FileSnapshot[]> {
  const filePath = getPiModelsPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const providers = isRecord(config.providers) ? { ...config.providers } : {};

  const existingProvider = isRecord(providers[provider.providerId]) ? providers[provider.providerId] : {};
  providers[provider.providerId] = toPiProviderConfig(provider, existingProvider);

  await writeJsonObject(filePath, { ...config, providers });
  return [snapshot];
}

async function writePiNativeConfigProviders(state: AgentConfigState): Promise<FileSnapshot[]> {
  const filePath = getPiModelsPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const providers: JsonRecord = {};

  for (const provider of state.providers) {
    const existingProvider = isRecord(providers[provider.providerId]) ? providers[provider.providerId] : {};
    providers[provider.providerId] = toPiProviderConfig(provider, existingProvider);
  }

  await writeJsonObject(filePath, { ...config, providers });
  return [snapshot];
}

async function writeDroidNativeConfig(state: AgentConfigState, provider: AgentProviderConfig): Promise<FileSnapshot[]> {
  const filePath = getDroidSettingsPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const managedIds = managedProviderIds(state);
  const existingModels = Array.isArray(config.customModels) ? config.customModels : [];
  const customModels = existingModels.filter((model) => {
    if (!isRecord(model)) return true;
    return !(model.hppManaged === true && managedIds.has(String(model.hppProviderId || "")));
  });

  for (const model of provider.models) {
    customModels.push({
      hppManaged: true,
      hppProviderId: provider.providerId,
      provider: "generic-chat-completion-api",
      model: model.id,
      id: `custom:${model.id}`,
      displayName: model.name || model.id,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      reasoning: !!model.reasoning,
      noImageSupport: !model.imageInput,
    });
  }

  await writeJsonObject(filePath, { ...config, customModels });
  return [snapshot];
}

async function writeDroidNativeConfigProviders(state: AgentConfigState): Promise<FileSnapshot[]> {
  const filePath = getDroidSettingsPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const customModels: JsonRecord[] = [];

  for (const provider of state.providers) {
    for (const model of provider.models) {
      customModels.push({
        hppManaged: true,
        hppProviderId: provider.providerId,
        provider: "generic-chat-completion-api",
        model: model.id,
        id: `custom:${model.id}`,
        displayName: model.name || model.id,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        reasoning: !!model.reasoning,
        noImageSupport: !model.imageInput,
      });
    }
  }

  await writeJsonObject(filePath, { ...config, customModels });
  return [snapshot];
}

function toOpenCodeProviderConfig(provider: AgentProviderConfig): JsonRecord {
  const models: JsonRecord = {};
  for (const model of provider.models) {
    models[model.id] = {
      name: model.name || model.id,
      reasoning: !!model.reasoning,
      attachment: !!model.imageInput,
      modalities: {
        input: model.imageInput ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    };
  }

  return {
    npm: "@ai-sdk/openai-compatible",
    name: provider.displayName || provider.providerId,
    options: {
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey,
    },
    models,
  };
}

async function writeOpenCodeNativeConfig(state: AgentConfigState, provider: AgentProviderConfig): Promise<FileSnapshot[]> {
  const filePath = getOpenCodeConfigPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const providers = isRecord(config.provider) ? { ...config.provider } : {};
  providers[provider.providerId] = toOpenCodeProviderConfig(provider);

  await writeJsonObject(filePath, { ...config, provider: providers });
  return [snapshot];
}

async function writeOpenCodeNativeConfigProviders(state: AgentConfigState): Promise<FileSnapshot[]> {
  const filePath = getOpenCodeConfigPath();
  const snapshot = await snapshotFile(filePath);
  const config = await readJsonObject(filePath);
  const providers: JsonRecord = {};

  for (const provider of state.providers) {
    providers[provider.providerId] = toOpenCodeProviderConfig(provider);
  }

  await writeJsonObject(filePath, { ...config, provider: providers });
  return [snapshot];
}

function escapeTomlString(value: string) {
  return JSON.stringify(value);
}

function tomlKey(key: string) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeTomlString(key);
}

function setTopLevelTomlValue(content: string, key: string, value: string) {
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

  const insertIndex = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
}

function getTopLevelTomlValue(content: string, key: string) {
  const lines = content ? content.split(/\r?\n/) : [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[")) return "";
    if (!line || line.startsWith("#")) continue;
    const pair = parseTomlKeyValue(rawLine);
    if (pair?.key === key) return pair.value;
  }
  return "";
}

function providerSectionHeader(providerId: string) {
  return `[model_providers.${tomlKey(providerId)}]`;
}

function getFirstCodexProviderSectionId(content: string) {
  for (const rawLine of content.split(/\r?\n/)) {
    const providerId = parseCodexProviderSection(rawLine);
    if (providerId) return providerId;
  }
  return "";
}

function upsertCodexProviderBaseUrl(content: string, providerId: string, baseUrl: string) {
  const lines = content ? content.split(/\r?\n/) : [];
  const nextLine = `base_url = ${escapeTomlString(baseUrl)}`;

  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (parseCodexProviderSection(lines[index]) === providerId) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    const suffix = lines.length > 0 && lines[lines.length - 1].trim() ? [""] : [];
    return [...lines, ...suffix, providerSectionHeader(providerId), nextLine, ""].join("\n");
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;

  for (let index = start + 1; index < end; index += 1) {
    const pair = parseTomlKeyValue(lines[index]);
    if (pair?.key === "base_url") {
      lines[index] = nextLine;
      return lines.join("\n");
    }
  }

  let insertIndex = end;
  while (insertIndex > start + 1 && !lines[insertIndex - 1].trim()) insertIndex -= 1;
  lines.splice(insertIndex, 0, nextLine);
  return lines.join("\n");
}

async function writeCodexNativeConfig(_state: AgentConfigState, provider: AgentProviderConfig): Promise<FileSnapshot[]> {
  const configPath = getCodexConfigPath();
  const authPath = getCodexAuthPath();
  const snapshots = await Promise.all([snapshotFile(configPath), snapshotFile(authPath)]);
  let configContent = await readTextFile(configPath);
  const activeNativeProviderId = getTopLevelTomlValue(configContent, "model_provider");
  const firstNativeProviderId = getFirstCodexProviderSectionId(configContent);
  const targetProviderId = activeNativeProviderId || firstNativeProviderId || "openai";
  const selectedModel = provider.models[0]?.id || CODEX_FALLBACK_MODEL_ID;

  if (!activeNativeProviderId && !firstNativeProviderId) {
    configContent = setTopLevelTomlValue(configContent, "model_provider", targetProviderId);
  }
  configContent = setTopLevelTomlValue(configContent, "model", selectedModel);
  configContent = upsertCodexProviderBaseUrl(configContent, targetProviderId, provider.baseUrl);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configContent.endsWith("\n") ? configContent : `${configContent}\n`, "utf-8");

  const auth = await readJsonObject(authPath);
  auth.OPENAI_API_KEY = provider.apiKey;
  await writeJsonObject(authPath, auth);

  return snapshots;
}

export async function writeNativeAgentProviderConfig(
  agentId: string,
  providerId: string
): Promise<{ state: AgentConfigState; provider: AgentProviderConfig; snapshots: FileSnapshot[] }> {
  ensureSupportedAgent(agentId);
  if (agentId !== "codex") {
    throw new Error("只有 Codex 需要启用指定渠道。");
  }
  const state = await readSavedCodexConfigState();
  const provider = state.providers.find((item) => item.providerId === providerId);
  if (!provider) throw new Error("未找到要启用的渠道。");
  validateProviderConfig(provider);

  const snapshots = await writeCodexNativeConfig(state, provider);

  return { state, provider, snapshots };
}

export async function writeNativeAgentConfig(
  agentId: string,
  stateOverride?: AgentConfigState
): Promise<{ state: AgentConfigState; snapshots: FileSnapshot[] }> {
  ensureSupportedAgent(agentId);
  if (agentId === "codex") {
    throw new Error("Codex 需要启用指定渠道后才能写入当前渠道。");
  }

  const state = stateOverride || await readNativeAgentConfigState(agentId);
  for (const provider of state.providers) {
    validateProviderConfig(provider);
  }

  const snapshots =
    agentId === "pi"
      ? await writePiNativeConfigProviders(state)
      : agentId === "droid"
        ? await writeDroidNativeConfigProviders(state)
        : await writeOpenCodeNativeConfigProviders(state);

  return { state, snapshots };
}

export async function getConfiguredAgentModels(agentId: string): Promise<Array<{
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
}>> {
  if (!SUPPORTED_CONFIG_AGENTS.has(agentId)) return [];
  const state = agentId === "codex"
    ? await readSavedCodexConfigState()
    : await readNativeAgentConfigState(agentId);
  const providers = agentId === "codex"
    ? [
        state.providers.find((provider) => provider.providerId === state.activeProviderId)
          || state.providers[0],
      ].filter((provider): provider is AgentProviderConfig => !!provider)
    : state.providers;

  return providers.flatMap((provider) => {
    const providerName = agentId === "codex" ? "codex" : provider.providerId;
    return provider.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: providerName,
      reasoning: !!model.reasoning,
      supportsImages: !!model.imageInput,
    }));
  });
}
