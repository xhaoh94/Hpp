import { app } from "electron";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { AgentProviderAuthMode, AgentProviderConfiguration } from "../../src/types/ipc";
import { createCopiedProviderId, resolveCompatibleProviderEndpoint } from "../../shared/agent-provider-copy";
import { asString, isRecord } from "../utils/unknown-value";
import { getAgentPluginRegistry } from "./agent-plugin-registry";

export interface AgentCustomModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  imageInput: boolean;
}

export type AgentProviderEndpoint = string;

export interface AgentProviderConfig {
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  authMode: AgentProviderAuthMode;
  endpoint: AgentProviderEndpoint;
  models: AgentCustomModelConfig[];
}

export interface AgentConfigState {
  activeProviderId?: string;
  providers: AgentProviderConfig[];
}

export interface AgentConfigResult {
  success: boolean;
  error?: string;
  config?: AgentConfigState;
  copiedProviderId?: string;
  models?: Array<{
    id: string;
    name: string;
    provider: string;
    reasoning: boolean;
    supportsImages?: boolean;
    supportedThinkingLevels?: string[];
  }>;
  reloadedSessionIds?: string[];
}

export interface AgentModelVisibilityResult {
  success: boolean;
  error?: string;
  backendModelsVisible?: boolean;
}

export interface FileSnapshot {
  filePath: string;
  existed: boolean;
  content: string;
}

type JsonRecord = Record<string, unknown>;

const SETTINGS_KEY = "agentConfigs";
const MODEL_PREFERENCES_KEY = "agentModelPreferences";

function getDataDir() {
  return join(app.getPath("userData"), "hpp-data");
}

function getSettingsPath() {
  return join(getDataDir(), "settings.json");
}

async function readJsonObject(filePath: string): Promise<JsonRecord> {
  try {
    const parsed = JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettings(settings: JsonRecord) {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function normalizeModel(value: unknown): AgentCustomModelConfig | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    name: asString(value.name) || id,
    reasoning: value.reasoning === true,
    imageInput: value.imageInput === true,
  };
}

function normalizeProvider(value: unknown, configuration: AgentProviderConfiguration): AgentProviderConfig | null {
  if (!isRecord(value)) return null;
  const providerId = asString(value.providerId);
  if (!providerId) return null;
  const endpoint = asString(value.endpoint);
  const declaredAuthModes = configuration.authModes?.map((option) => option.id) || ["bearer"];
  const requestedAuthMode = asString(value.authMode) as AgentProviderAuthMode;
  const authMode = declaredAuthModes.includes(requestedAuthMode)
    ? requestedAuthMode
    : configuration.defaultAuthMode || declaredAuthModes[0] || "bearer";
  const models = Array.isArray(value.models)
    ? value.models.map(normalizeModel).filter((model): model is AgentCustomModelConfig => !!model)
    : [];
  return {
    providerId,
    displayName: asString(value.displayName) || providerId,
    baseUrl: asString(value.baseUrl),
    apiKey: asString(value.apiKey),
    authMode,
    endpoint: endpoint || configuration.defaultEndpoint,
    models,
  };
}

function normalizeState(value: unknown, configuration: AgentProviderConfiguration): AgentConfigState {
  const record = isRecord(value) ? value : {};
  const providers = Array.isArray(record.providers)
    ? record.providers
        .map((provider) => normalizeProvider(provider, configuration))
        .filter((provider): provider is AgentProviderConfig => !!provider)
    : [];
  const activeProviderId = asString(record.activeProviderId);
  return {
    activeProviderId: activeProviderId && providers.some((provider) => provider.providerId === activeProviderId)
      ? activeProviderId
      : undefined,
    providers,
  };
}

function getOriginalProviderId(value: unknown): string | undefined {
  return isRecord(value) ? asString(value.originalProviderId) || undefined : undefined;
}

async function getProviderConfiguration(agentId: string): Promise<AgentProviderConfiguration> {
  const capabilities = await getAgentPluginRegistry().getCapabilities(agentId);
  if (!capabilities.configuration || capabilities.configuration === "none") {
    throw new Error("当前 Agent 不支持渠道配置。");
  }
  return capabilities.configuration;
}

async function usesSingleActiveProvider(agentId: string) {
  const capabilities = await getAgentPluginRegistry().getCapabilities(agentId);
  return capabilities.providerActivation === "single-active";
}

async function readBackendModelsVisible(
  agentId: string,
  configuration: AgentProviderConfiguration,
): Promise<boolean> {
  const declaration = configuration.backendModelVisibility;
  if (!declaration) return true;
  const settings = await readJsonObject(getSettingsPath());
  const allPreferences = isRecord(settings[MODEL_PREFERENCES_KEY]) ? settings[MODEL_PREFERENCES_KEY] : {};
  const preferences = isRecord(allPreferences[agentId]) ? allPreferences[agentId] : {};
  return typeof preferences.backendModelsVisible === "boolean"
    ? preferences.backendModelsVisible
    : declaration.defaultVisible;
}

export async function shouldShowAgentBackendModels(agentId: string): Promise<boolean> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    return readBackendModelsVisible(agentId, configuration);
  } catch {
    return true;
  }
}

export async function getAgentModelVisibility(agentId: string): Promise<AgentModelVisibilityResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    if (!configuration.backendModelVisibility) {
      throw new Error("当前 Agent 未提供模型来源显示选项。");
    }
    return {
      success: true,
      backendModelsVisible: await readBackendModelsVisible(agentId, configuration),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setAgentBackendModelsVisible(
  agentId: string,
  visible: boolean,
): Promise<AgentModelVisibilityResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    const declaration = configuration.backendModelVisibility;
    if (!declaration?.userConfigurable) {
      throw new Error("当前 Agent 不允许修改模型来源显示选项。");
    }
    const settings = await readJsonObject(getSettingsPath());
    const allPreferences = isRecord(settings[MODEL_PREFERENCES_KEY]) ? settings[MODEL_PREFERENCES_KEY] : {};
    const currentPreferences = isRecord(allPreferences[agentId]) ? allPreferences[agentId] : {};
    settings[MODEL_PREFERENCES_KEY] = {
      ...allPreferences,
      [agentId]: { ...currentPreferences, backendModelsVisible: visible },
    };
    await writeSettings(settings);
    return { success: true, backendModelsVisible: visible };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readSavedAgentConfigEntry(
  agentId: string,
  configuration: AgentProviderConfiguration,
): Promise<{ exists: boolean; state: AgentConfigState }> {
  const settings = await readJsonObject(getSettingsPath());
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  return {
    exists: Object.prototype.hasOwnProperty.call(allConfigs, agentId),
    state: normalizeState(allConfigs[agentId], configuration),
  };
}

async function writeAgentConfigState(agentId: string, state: AgentConfigState) {
  const settings = await readJsonObject(getSettingsPath());
  const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  settings[SETTINGS_KEY] = { ...allConfigs, [agentId]: state };
  await writeSettings(settings);
}

async function readCurrentAgentConfigState(
  agentId: string,
  configuration?: AgentProviderConfiguration,
): Promise<AgentConfigState> {
  const resolvedConfiguration = configuration || await getProviderConfiguration(agentId);
  if (resolvedConfiguration.storage === "hpp") {
    const saved = await readSavedAgentConfigEntry(agentId, resolvedConfiguration);
    if (saved.exists) return saved.state;
    const discovered = await getAgentPluginRegistry().readProviderConfig(agentId);
    const state = normalizeState(discovered, resolvedConfiguration);
    if (discovered !== undefined && (state.activeProviderId || state.providers.length > 0)) {
      await writeAgentConfigState(agentId, state);
    }
    return state;
  }

  const nativeState = await getAgentPluginRegistry().readProviderConfig(agentId);
  if (nativeState === undefined) {
    throw new Error(`插件 ${agentId} 声明了插件配置存储，但未导出 configProvider.read。`);
  }
  return normalizeState(nativeState, resolvedConfiguration);
}

async function persistAgentConfigState(
  agentId: string,
  state: AgentConfigState,
  configuration: AgentProviderConfiguration,
) {
  if (configuration.storage === "hpp") {
    await writeAgentConfigState(agentId, state);
    return;
  }
  await getAgentPluginRegistry().writeProviderConfig(agentId, state);
}

function validateProviderConfig(provider: AgentProviderConfig, configuration: AgentProviderConfiguration) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(provider.providerId)) {
    throw new Error("渠道 ID 只能包含字母、数字、点、下划线、冒号和短横线。");
  }
  if (!provider.baseUrl) throw new Error("请填写渠道 URL。");
  if (!configuration.endpoints.some((endpoint) => endpoint.id === provider.endpoint)) {
    throw new Error(`当前插件不支持 Endpoint：${provider.endpoint || "空"}`);
  }
  const authModes = configuration.authModes?.map((option) => option.id) || ["bearer"];
  if (!authModes.includes(provider.authMode)) {
    throw new Error(`当前插件不支持鉴权方式：${provider.authMode || "空"}`);
  }
  if (!provider.apiKey) throw new Error("请填写 sk-key。");
  if (provider.models.length === 0) throw new Error("至少需要添加一个模型。");
  for (const model of provider.models) {
    if (!model.id.trim()) throw new Error("模型 ID 不能为空。");
  }
}

function normalizeSnapshots(value: unknown): FileSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const filePath = asString(item.filePath);
    if (!filePath) return [];
    return [{
      filePath,
      existed: item.existed === true,
      content: typeof item.content === "string" ? item.content : "",
    }];
  });
}

export async function getAgentConfigStateForBackend(agentId: string): Promise<AgentConfigState> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    return readCurrentAgentConfigState(agentId, configuration);
  } catch {
    return { providers: [] };
  }
}

export async function listAgentConfig(agentId: string): Promise<AgentConfigResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    return { success: true, config: await readCurrentAgentConfigState(agentId, configuration) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function saveAgentProviderConfig(agentId: string, providerValue: unknown): Promise<AgentConfigResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    const provider = normalizeProvider(providerValue, configuration);
    if (!provider) throw new Error("渠道配置无效。");
    validateProviderConfig(provider, configuration);
    const originalProviderId = getOriginalProviderId(providerValue);
    const state = await readCurrentAgentConfigState(agentId, configuration);
    const replaceProviderId = originalProviderId || provider.providerId;
    const existingIndex = state.providers.findIndex((item) => item.providerId === replaceProviderId);
    const providers = state.providers.filter((item) =>
      item.providerId !== provider.providerId && item.providerId !== originalProviderId
    );
    if (existingIndex >= 0) providers.splice(Math.min(existingIndex, providers.length), 0, provider);
    else providers.push(provider);
    const nextState = {
      activeProviderId: state.activeProviderId === originalProviderId ? provider.providerId : state.activeProviderId,
      providers,
    };
    await persistAgentConfigState(agentId, nextState, configuration);
    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function copyAgentProviderConfig(
  sourceAgentId: string,
  sourceProviderId: string,
  targetAgentId: string,
): Promise<AgentConfigResult> {
  try {
    if (!sourceAgentId || !targetAgentId) throw new Error("请选择渠道复制目标。");
    const sourceConfiguration = await getProviderConfiguration(sourceAgentId);
    const targetConfiguration = sourceAgentId === targetAgentId
      ? sourceConfiguration
      : await getProviderConfiguration(targetAgentId);
    const sourceState = await readCurrentAgentConfigState(sourceAgentId, sourceConfiguration);
    const targetState = sourceAgentId === targetAgentId
      ? sourceState
      : await readCurrentAgentConfigState(targetAgentId, targetConfiguration);
    const sourceProvider = sourceState.providers.find((provider) => provider.providerId === sourceProviderId);
    if (!sourceProvider) throw new Error(`未找到要复制的渠道：${sourceProviderId}`);
    const endpoint = resolveCompatibleProviderEndpoint(sourceProvider.endpoint, targetConfiguration.endpoints);
    if (!endpoint) {
      throw new Error(`目标 Agent 不支持 Endpoint：${sourceProvider.endpoint}`);
    }
    const targetAuthModes = targetConfiguration.authModes?.map((option) => option.id) || ["bearer"];
    const authMode = targetAuthModes.includes(sourceProvider.authMode)
      ? sourceProvider.authMode
      : targetConfiguration.defaultAuthMode || targetAuthModes[0] || "bearer";
    const copiedProviderId = createCopiedProviderId(
      sourceProvider.providerId,
      targetState.providers.map((provider) => provider.providerId),
    );
    const models = sourceProvider.models.map((model) => targetConfiguration.fixedModelCapabilities
      ? {
          ...model,
          reasoning: targetConfiguration.modelDefaults.reasoning,
          imageInput: targetConfiguration.modelDefaults.imageInput,
        }
      : { ...model });
    const result = await saveAgentProviderConfig(targetAgentId, {
      ...sourceProvider,
      providerId: copiedProviderId,
      endpoint,
      authMode,
      models,
    });
    return result.success ? { ...result, copiedProviderId } : result;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteAgentProviderConfig(agentId: string, providerId: string): Promise<AgentConfigResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    const state = await readCurrentAgentConfigState(agentId, configuration);
    const targetProviderId = asString(providerId);
    if (!targetProviderId) throw new Error("渠道 ID 无效。");
    if (!state.providers.some((provider) => provider.providerId === targetProviderId)) {
      throw new Error(`未找到渠道：${targetProviderId}`);
    }
    if (await usesSingleActiveProvider(agentId) && state.activeProviderId === targetProviderId) {
      throw new Error("当前启用的渠道不能直接删除，请先启用其它渠道。");
    }
    const nextState = {
      activeProviderId: state.activeProviderId === targetProviderId ? undefined : state.activeProviderId,
      providers: state.providers.filter((provider) => provider.providerId !== targetProviderId),
    };
    await persistAgentConfigState(agentId, nextState, configuration);
    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function reorderAgentProviderConfigs(agentId: string, providerOrderValue: unknown): Promise<AgentConfigResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    if (!Array.isArray(providerOrderValue)) throw new Error("渠道顺序无效。");
    const providerOrder = providerOrderValue.map(asString);
    if (providerOrder.some((providerId) => !providerId)) throw new Error("渠道顺序包含空 ID。");
    const state = await readCurrentAgentConfigState(agentId, configuration);
    if (providerOrder.length !== state.providers.length) throw new Error("渠道顺序必须包含全部渠道。");
    const providerById = new Map(state.providers.map((provider) => [provider.providerId, provider]));
    const seen = new Set<string>();
    for (const providerId of providerOrder) {
      if (seen.has(providerId)) throw new Error("渠道顺序包含重复 ID。");
      if (!providerById.has(providerId)) throw new Error(`未找到渠道：${providerId}`);
      seen.add(providerId);
    }
    const nextState = {
      activeProviderId: state.activeProviderId,
      providers: providerOrder.map((providerId) => providerById.get(providerId)!),
    };
    await persistAgentConfigState(agentId, nextState, configuration);
    return { success: true, config: nextState };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setActiveAgentProviderConfig(agentId: string, providerId: string): Promise<AgentConfigState> {
  if (!(await usesSingleActiveProvider(agentId))) throw new Error("当前 Agent 不支持启用单个渠道。");
  const configuration = await getProviderConfiguration(agentId);
  const state = await readCurrentAgentConfigState(agentId, configuration);
  if (!state.providers.some((provider) => provider.providerId === providerId)) {
    throw new Error("未找到要启用的渠道。");
  }
  const nextState = { ...state, activeProviderId: providerId };
  await persistAgentConfigState(agentId, nextState, configuration);
  return nextState;
}

export async function activateAgentProviderConfig(
  agentId: string,
  providerId: string,
): Promise<{ state: AgentConfigState; provider: AgentProviderConfig; snapshots: FileSnapshot[] }> {
  if (!(await usesSingleActiveProvider(agentId))) throw new Error("当前 Agent 不支持启用单个渠道。");
  const configuration = await getProviderConfiguration(agentId);
  const state = await readCurrentAgentConfigState(agentId, configuration);
  const provider = state.providers.find((item) => item.providerId === providerId);
  if (!provider) throw new Error("未找到要启用的渠道。");
  validateProviderConfig(provider, configuration);
  const result = await getAgentPluginRegistry().activateProvider(agentId, { providerId, provider, state });
  return { state, provider, snapshots: normalizeSnapshots(result.snapshots) };
}

export async function restoreNativeConfigSnapshot(snapshot: FileSnapshot) {
  if (snapshot.existed) {
    await mkdir(dirname(snapshot.filePath), { recursive: true });
    await writeFile(snapshot.filePath, snapshot.content, "utf8");
  } else {
    await rm(snapshot.filePath, { force: true });
  }
}

export async function restoreNativeConfigSnapshots(snapshots: FileSnapshot[]) {
  for (const snapshot of snapshots) await restoreNativeConfigSnapshot(snapshot);
}

export async function getConfiguredAgentModels(
  agentId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Array<{
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}>> {
  const registry = getAgentPluginRegistry();
  const capabilities = await registry.getCapabilities(agentId);
  const configuration = await getProviderConfiguration(agentId);
  const state = await readCurrentAgentConfigState(agentId, configuration);
  const providers = options.activeOnly && capabilities.providerActivation === "single-active"
    ? state.providers.filter((provider) => provider.providerId === state.activeProviderId)
    : state.providers;
  return providers.flatMap((provider) => provider.models.map((model) => ({
    id: model.id,
    name: model.name || model.id,
    provider: provider.providerId,
    reasoning: model.reasoning === true,
    supportsImages: model.imageInput === true,
    supportedThinkingLevels: configuration.modelDefaults.supportedThinkingLevels,
  })));
}
