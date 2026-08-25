import { app } from "electron";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { AgentProviderAuthMode, AgentProviderConfiguration } from "../../src/types/ipc";
import { createCopiedProviderId, resolveCompatibleProviderEndpoint } from "../../shared/agent-provider-copy";
import { normalizeSupportedThinkingLevels } from "../../shared/models";
import { asString, isRecord } from "../utils/unknown-value";
import { getAgentPluginRegistry } from "./agent-plugin-registry";

export interface AgentCustomModelConfig {
  id: string;
  name: string;
  /** 内置模型来自 Agent 能力；自定义模型由 supportedThinkingLevels 是否非空派生。 */
  reasoning: boolean;
  imageInput: boolean;
  /**
   * 模型声明的思考档位。未知档位保持原值；对自定义模型而言，空值表示不支持思考。
   */
  supportedThinkingLevels?: string[];
  /** 旧版兼容字段；配置控件当前仅由 isBuiltin 决定是否显示。 */
  hasThinkingLevels?: boolean;
  /** 该模型是否在 Agent 内置目录中（能力由 Agent 管理，配置弹窗不显示能力控件）。 */
  isBuiltin?: boolean;
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
    thinkingLevelMode?: "levels" | "toggle";
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
  const supportedThinkingLevels = normalizeSupportedThinkingLevels(value.supportedThinkingLevels);
  const isBuiltin = value.isBuiltin === true;
  return {
    id,
    name: asString(value.name) || id,
    // 内置模型使用 Agent 目录的 reasoning；自定义模型由思考档位是否非空决定。
    reasoning: isBuiltin ? value.reasoning === true : supportedThinkingLevels.length > 0,
    imageInput: value.imageInput === true,
    ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
    ...(value.hasThinkingLevels === true || supportedThinkingLevels.length > 0 ? { hasThinkingLevels: true } : {}),
    ...(isBuiltin ? { isBuiltin: true } : {}),
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

// 旧版保存的 hpp 配置里没有 hasThinkingLevels/isBuiltin 字段（能力标记是派生信息）。
// 打开配置弹窗时用插件实时发现结果（读 models.json + 渠道目录）补全：
// 内置目录模型（如 deepseek/mimo）的能力（reasoning/imageInput/thinkingLevels）由 Agent
// 自身管理，配置弹窗不显示能力控件；非内置（自定义）模型才显示控件供自定义。
async function enrichWithDiscoveredThinkingLevels(
  agentId: string,
  state: AgentConfigState,
): Promise<AgentConfigState> {
  try {
    const discovered = await getAgentPluginRegistry().readProviderConfig(agentId);
    if (discovered === undefined) return state;
    const discoveredState = normalizeState(discovered, await getProviderConfiguration(agentId));
    const discoveredByKey = new Map<string, AgentCustomModelConfig>();
    const discoveredById = new Map<string, AgentCustomModelConfig>();
    for (const provider of discoveredState.providers) {
      for (const model of provider.models) {
        discoveredByKey.set(`${provider.providerId}/${model.id}`, model);
        // 按 modelId 跨 provider 兜底：用户自定义渠道的 providerId 可能与
        // 插件内置目录的 providerId 不同，但模型 id 相同（如 gpt-5.6-sol 在
        // 自定义渠道 tanwan 下和 pi 内置 opencode 下同名）。
        discoveredById.set(model.id, model);
      }
    }
    if (discoveredByKey.size === 0) return state;
    return {
      ...state,
      providers: state.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => {
          // 先按 providerId/modelId 精确匹配，找不到时按 modelId 跨 provider 兜底。
          const discoveredModel = discoveredByKey.get(`${provider.providerId}/${model.id}`)
            || discoveredById.get(model.id);
          if (!discoveredModel) {
            // 插件发现结果里没有该模型（id 未同步 / 渠道外手动添加）→
            // 按“非内置”处理，提供自定义能力控件。
            return { ...model, isBuiltin: false, hasThinkingLevels: true };
          }
          const merged: AgentCustomModelConfig = { ...model };
          // 采用最新发现的 isBuiltin / hasThinkingLevels：内置模型不显示能力控件，
          // 非内置模型显示控件。避免旧版保存的值残留。
          merged.isBuiltin = discoveredModel.isBuiltin === true;
          merged.hasThinkingLevels = discoveredModel.hasThinkingLevels === true;
          // 内置模型的能力（reasoning/imageInput）以目录为权威。
          merged.reasoning = discoveredModel.reasoning;
          merged.imageInput = discoveredModel.imageInput;
          // 旧配置没有档位时，用内置模型的内置档位预填（如 deepseek 的 high/max）。
          if (!model.supportedThinkingLevels?.length && discoveredModel.supportedThinkingLevels?.length) {
            merged.supportedThinkingLevels = discoveredModel.supportedThinkingLevels;
          }
          return merged;
        }),
      })),
    };
  } catch {
    // 插件发现失败时保持已保存的状态原样。
    return state;
  }
}

async function readCurrentAgentConfigState(
  agentId: string,
  configuration?: AgentProviderConfiguration,
): Promise<AgentConfigState> {
  const resolvedConfiguration = configuration || await getProviderConfiguration(agentId);
  if (resolvedConfiguration.storage === "hpp") {
    const saved = await readSavedAgentConfigEntry(agentId, resolvedConfiguration);
    if (saved.exists) {
      return enrichWithDiscoveredThinkingLevels(agentId, saved.state);
    }
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

export interface AgentModelLookupResult {
  success: boolean;
  error?: string;
  builtin: boolean;
  model?: Pick<AgentCustomModelConfig, "reasoning" | "imageInput" | "supportedThinkingLevels"> & { name?: string };
}

/**
 * 未保存前实时判定模型是否为 Agent 内置模型：插件未实现 lookupModel 或
 * 目录中查不到时返回 builtin=false，配置弹窗按自定义模型处理。
 */
export async function lookupAgentModel(agentId: string, modelId: string): Promise<AgentModelLookupResult> {
  const id = asString(modelId);
  if (!id) return { success: true, builtin: false };
  try {
    const raw = await getAgentPluginRegistry().lookupModel(agentId, id);
    if (!isRecord(raw) || raw.isBuiltin !== true) return { success: true, builtin: false };
    const supportedThinkingLevels = normalizeSupportedThinkingLevels(raw.supportedThinkingLevels);
    return {
      success: true,
      builtin: true,
      model: {
        name: asString(raw.name) || undefined,
        reasoning: raw.reasoning === true,
        imageInput: raw.imageInput === true,
        ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
      },
    };
  } catch (error) {
    return { success: false, builtin: false, error: error instanceof Error ? error.message : String(error) };
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
    // 写入后重新读取一次，让插件/目录重新派生 isBuiltin、图片能力和内置档位。
    // 这样手动输入一个内置模型 ID 后，无需关闭整个配置弹窗再打开才能得到正确界面。
    const persistedState = await readCurrentAgentConfigState(agentId, configuration);
    return { success: true, config: persistedState };
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
  thinkingLevelMode?: "levels" | "toggle";
}>> {
  const registry = getAgentPluginRegistry();
  const capabilities = await registry.getCapabilities(agentId);
  const configuration = await getProviderConfiguration(agentId);
  const state = await readCurrentAgentConfigState(agentId, configuration);
  const providers = options.activeOnly && capabilities.providerActivation === "single-active"
    ? state.providers.filter((provider) => provider.providerId === state.activeProviderId)
    : state.providers;
  return providers.flatMap((provider) => provider.models.map((model) => {
    // 内置模型使用插件发现后写入 model 的档位；非内置模型只认用户显式勾选的档位。
    // 缺少档位是有意义的（显示思考开关），不能再用 agent 级默认值把它误变成下拉。
    const supportedThinkingLevels = normalizeSupportedThinkingLevels(model.supportedThinkingLevels);
    const selectableLevelCount = supportedThinkingLevels.filter((level) => level !== "off").length;
    const usesLevelDropdown = model.isBuiltin
      ? selectableLevelCount > 0
      : selectableLevelCount > 1;
    const thinkingLevelMode = model.reasoning === true
      ? (usesLevelDropdown ? "levels" : "toggle")
      : undefined;
    return {
      id: model.id,
      name: model.name || model.id,
      provider: provider.providerId,
      reasoning: model.reasoning === true,
      supportsImages: model.imageInput === true,
      ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
      ...(thinkingLevelMode ? { thinkingLevelMode } : {}),
    };
  }));
}
