import { app } from "electron";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type {
  AgentBuiltinExtensionCapabilities,
  AgentProviderAuthMode,
  AgentProviderConfiguration,
  AgentCreditClaimResult,
  AgentProviderLoginResult,
} from "../../src/types/ipc";
import { createCopiedProviderId, resolveCompatibleProviderEndpoint } from "../../shared/agent-provider-copy";
import { normalizeSupportedThinkingLevels } from "../../shared/models";
import { asString, isRecord } from "../utils/unknown-value";
import { getAgentPluginRegistry } from "./agent-plugin-registry";
import { queueNamedWrite } from "../utils/write-queue";
import { normalizeAgentSubagentConfig, type AgentSubagentConfig } from "../../shared/agent-subagent";

export interface AgentCustomModelConfig {
  id: string;
  name: string;
  /** 内置模型来自 Agent 能力；自定义模型由 supportedThinkingLevels 是否非空派生。 */
  reasoning: boolean;
  imageInput: boolean;
  /** 模型上下文窗口大小（tokens），目录未提供时为空。 */
  contextWindow?: number;
  /**
   * 模型声明的思考档位。未知档位保持原值；对自定义模型而言，空值表示不支持思考。
   */
  supportedThinkingLevels?: string[];
  /** 旧版兼容字段；配置控件当前仅由 isBuiltin 决定是否显示。 */
  hasThinkingLevels?: boolean;
  /** 该模型是否在 Agent 内置目录中（能力由 Agent 管理，配置弹窗不显示能力控件）。 */
  isBuiltin?: boolean;
  /** 模型级 Endpoint 覆盖；缺省继承渠道。 */
  endpoint?: AgentProviderEndpoint;
  /** 模型级 URL 覆盖；缺省沿用渠道 URL。 */
  baseUrl?: string;
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

/** 启用的上游内置扩展 id 集合（codemode / tool_search 等）。 */
export interface AgentBuiltinExtensionsResult {
  success: boolean;
  error?: string;
  enabledIds?: string[];
}

export interface FileSnapshot {
  filePath: string;
  existed: boolean;
  content: string;
}

type JsonRecord = Record<string, unknown>;

const SETTINGS_KEY = "agentConfigs";
const MODEL_PREFERENCES_KEY = "agentModelPreferences";
const BUILTIN_EXTENSIONS_KEY = "agentBuiltinExtensions";

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

/** 所有 Agent settings 的读改写与 store:save 共用同一进程内队列。 */
async function updateSettings<T>(update: (settings: JsonRecord) => Promise<T> | T): Promise<T> {
  return queueNamedWrite("settings", async () => {
    const settings = await readJsonObject(getSettingsPath());
    const result = await update(settings);
    await writeSettings(settings);
    return result;
  });
}

/** 原子地更新单个 Agent 的 SubAgent 配置，避免 renderer 读改写整个 settings 丢失并发字段。 */
export async function saveAgentSubagentConfig(
  agentId: string,
  value: unknown,
): Promise<{ success: boolean; error?: string; config?: AgentSubagentConfig }> {
  const config = normalizeAgentSubagentConfig(value);
  try {
    await updateSettings((settings) => {
      const all = isRecord(settings.subagentConfigs) ? settings.subagentConfigs : {};
      settings.subagentConfigs = { ...all, [agentId]: config };
    });
    return { success: true, config };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeModel(value: unknown): AgentCustomModelConfig | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  const supportedThinkingLevels = normalizeSupportedThinkingLevels(value.supportedThinkingLevels);
  const isBuiltin = value.isBuiltin === true;
  const endpoint = asString(value.endpoint);
  const baseUrl = asString(value.baseUrl);
  return {
    id,
    name: asString(value.name) || id,
    // 内置模型使用 Agent 目录的 reasoning；自定义模型由思考档位是否非空决定。
    reasoning: isBuiltin ? value.reasoning === true : supportedThinkingLevels.length > 0,
    imageInput: value.imageInput === true,
    ...(Number.isFinite(Number(value.contextWindow)) && Number(value.contextWindow) > 0
      ? { contextWindow: Number(value.contextWindow) }
      : {}),
    ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
    ...(value.hasThinkingLevels === true || supportedThinkingLevels.length > 0 ? { hasThinkingLevels: true } : {}),
    ...(isBuiltin ? { isBuiltin: true } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(baseUrl ? { baseUrl } : {}),
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
  const supportsModelEndpoints = configuration.modelEndpointOverrides === true;
  const providers = Array.isArray(record.providers)
    ? record.providers
        .map((provider) => normalizeProvider(provider, configuration))
        .filter((provider): provider is AgentProviderConfig => !!provider)
        // 不支持模型级端点的 Agent 读回时直接丢掉这两个字段，
        // 否则草稿里会带着界面上根本改不了的覆盖值，保存必然被校验拒绝。
        .map((provider) => supportsModelEndpoints ? provider : {
          ...provider,
          models: provider.models.map(({ endpoint: _endpoint, baseUrl: _baseUrl, ...model }) => model),
        })
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
    await updateSettings((settings) => {
      const allPreferences = isRecord(settings[MODEL_PREFERENCES_KEY]) ? settings[MODEL_PREFERENCES_KEY] : {};
      const currentPreferences = isRecord(allPreferences[agentId]) ? allPreferences[agentId] : {};
      settings[MODEL_PREFERENCES_KEY] = {
        ...allPreferences,
        [agentId]: { ...currentPreferences, backendModelsVisible: visible },
      };
    });
    return { success: true, backendModelsVisible: visible };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** MCP 工具的两种接入方式，缺一个就会有一类工具调不到。 */
const MCP_TOOL_EXPOSURE_IDS = ["tool_search", "codemode"] as const;

/**
 * 用户只需要决定「开不开 MCP」；工具以什么方式暴露给模型由 Hpp 决定。
 *
 * 两个都要挂，因为它们覆盖的是不同的 exposure 档：
 * - `tool_search` 管 `deferred`（按需检索，Plan 只读模式下也能用）
 * - `codemode` 管 `codemode`（只能从脚本里调，也是 pi 的默认档）
 * 缺任何一个，对应档位的 server 工具对模型都不可见，Pi 每次会话都会告警。
 *
 * 旧配置里残留的 codemode / tool_search 一律按这里重写，不沿用。
 */
function resolveBuiltinExtensions(enabled: string[], known: Set<string>): string[] {
  const userEnabled = enabled.filter((id) => id !== "codemode" && id !== "tool_search");
  if (!userEnabled.includes("mcp")) return userEnabled;
  return [...userEnabled, ...MCP_TOOL_EXPOSURE_IDS.filter((id) => known.has(id))];
}

async function getBuiltinExtensionDeclaration(
  agentId: string,
): Promise<AgentBuiltinExtensionCapabilities | undefined> {
  const capabilities = await getAgentPluginRegistry().getCapabilities(agentId);
  const declaration = capabilities.builtinExtensions;
  return declaration && declaration !== "none" && declaration.userConfigurable
    ? declaration
    : undefined;
}

/**
 * 读取某个 agent 已启用的内置扩展。
 * 返回 null 表示该agent 没有这项能力，调用方应跳过而不是当成「全关」。
 */
export async function getAgentBuiltinExtensions(agentId: string): Promise<string[] | null> {
  try {
    const declaration = await getBuiltinExtensionDeclaration(agentId);
    if (!declaration) return null;
    const settings = await readJsonObject(getSettingsPath());
    const all = isRecord(settings[BUILTIN_EXTENSIONS_KEY]) ? settings[BUILTIN_EXTENSIONS_KEY] : {};
    const saved = Array.isArray(all[agentId]) ? all[agentId].map(String) : undefined;
    // 存过的值只保留插件仍声明的 id：插件升级删掉某个扩展后不该留下幽灵开关。
    const known = new Set(declaration.options.map((option) => option.id));
    const resolved = [...new Set((saved ?? declaration.defaultEnabled).filter((id) => known.has(id)))];
    const enabled = resolveBuiltinExtensions(resolved, known);
    // 顺序也要比：老配置里 codemode/tool_search 的顺序和现在不一样，只比长度会漏掉回写。
    const changed = enabled.length !== resolved.length
      || enabled.some((id, index) => id !== resolved[index]);
    if (changed) {
      // 老配置（只开了 MCP、或残留 codemode/tool_search）自动归一化，保证下次读取和 UI 显示一致。
      await updateSettings((settings) => {
        const all = isRecord(settings[BUILTIN_EXTENSIONS_KEY]) ? settings[BUILTIN_EXTENSIONS_KEY] : {};
        settings[BUILTIN_EXTENSIONS_KEY] = { ...all, [agentId]: enabled };
      });
    }
    return enabled;
  } catch {
    return [];
  }
}

export async function getAgentBuiltinExtensionsResult(agentId: string): Promise<AgentBuiltinExtensionsResult> {
  try {
    const enabledIds = await getAgentBuiltinExtensions(agentId);
    if (enabledIds === null) {
      return { success: false, error: "当前 Agent 未提供内置扩展开关。" };
    }
    return { success: true, enabledIds };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setAgentBuiltinExtensions(
  agentId: string,
  enabledIds: string[],
): Promise<AgentBuiltinExtensionsResult> {
  try {
    const declaration = await getBuiltinExtensionDeclaration(agentId);
    if (!declaration) {
      throw new Error("当前 Agent 不允许修改内置扩展开关。");
    }
    const known = new Set(declaration.options.map((option) => option.id));
    const next = resolveBuiltinExtensions(
      [...new Set((enabledIds || []).map(String).filter((id) => known.has(id)))],
      known,
    );
    await updateSettings((settings) => {
      const all = isRecord(settings[BUILTIN_EXTENSIONS_KEY]) ? settings[BUILTIN_EXTENSIONS_KEY] : {};
      settings[BUILTIN_EXTENSIONS_KEY] = { ...all, [agentId]: next };
    });
    return { success: true, enabledIds: next };
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
  await updateSettings((settings) => {
    const allConfigs = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
    settings[SETTINGS_KEY] = { ...allConfigs, [agentId]: state };
  });
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
          // 内置模型的能力（reasoning/imageInput/思考档位）以目录为权威：目录有值时直接覆盖，
          // 避免旧配置里的档位与插件/服务端最新下发的目录脱节。
          merged.reasoning = discoveredModel.reasoning;
          merged.imageInput = discoveredModel.imageInput;
          if (discoveredModel.supportedThinkingLevels?.length) {
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

function validateProviderConfig(
  provider: AgentProviderConfig,
  configuration: AgentProviderConfiguration,
  options: { allowEmptyApiKey?: boolean } = {},
) {
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
  // 登录态在 CLI 里的 Agent（如 CodeBuddy）渠道不存 token，所以允许空 apiKey。
  if (!provider.apiKey && options.allowEmptyApiKey !== true) throw new Error("请填写 sk-key。");
  if (provider.models.length === 0) throw new Error("至少需要添加一个模型。");
  if (!configuration.modelEndpointOverrides) {
    const overridden = provider.models.find((model) => model.endpoint || model.baseUrl);
    if (overridden) {
      throw new Error(`当前 Agent 不支持按模型覆盖端点（模型 ${overridden.id || "未命名"}），请删除该模型的端点后再保存。`);
    }
  }
  for (const model of provider.models) {
    if (!model.id.trim()) throw new Error("模型 ID 不能为空。");
    if (model.endpoint && !configuration.endpoints.some((endpoint) => endpoint.id === model.endpoint)) {
      throw new Error(`模型 ${model.id} 的 Endpoint 不受支持：${model.endpoint}`);
    }
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

/** Agent 是否支持账号登录（登录态在 CLI 里，渠道不需要 token）。 */
async function allowsEmptyApiKey(agentId: string): Promise<boolean> {
  try {
    return (await getAgentPluginRegistry().getCapabilities(agentId)).providerLogin === true;
  } catch {
    return false;
  }
}

export async function saveAgentProviderConfig(agentId: string, providerValue: unknown): Promise<AgentConfigResult> {
  try {
    const configuration = await getProviderConfiguration(agentId);
    const provider = normalizeProvider(providerValue, configuration);
    if (!provider) throw new Error("渠道配置无效。");
    validateProviderConfig(provider, configuration, { allowEmptyApiKey: await allowsEmptyApiKey(agentId) });
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
    const endpoint = resolveCompatibleProviderEndpoint(
      sourceProvider.endpoint,
      targetConfiguration.endpoints,
      targetConfiguration.defaultEndpoint,
    );
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
    // 模型级端点只在目标 Agent 支持且能映射到同类端点时带过去；
    // 否则整条复制会因为校验失败而做废，比丢掉覆盖更糟。
    const models = sourceProvider.models.map((model) => {
      const { endpoint: modelEndpoint, baseUrl: modelBaseUrl, ...rest } = model;
      const targetModelEndpoint = targetConfiguration.modelEndpointOverrides === true && modelEndpoint
        ? resolveCompatibleProviderEndpoint(modelEndpoint, targetConfiguration.endpoints)
        : undefined;
      return {
        ...rest,
        ...(targetConfiguration.fixedModelCapabilities
          ? {
              reasoning: targetConfiguration.modelDefaults.reasoning,
              imageInput: targetConfiguration.modelDefaults.imageInput,
            }
          : {}),
        ...(targetModelEndpoint ? { endpoint: targetModelEndpoint } : {}),
        ...(targetModelEndpoint && modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
      };
    });
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
  validateProviderConfig(provider, configuration, { allowEmptyApiKey: await allowsEmptyApiKey(agentId) });
  const result = await getAgentPluginRegistry().activateProvider(agentId, { providerId, provider, state });
  return { state, provider, snapshots: normalizeSnapshots(result.snapshots) };
}

/**
 * 渠道账号登录（OAuth）。插件可以实现 configProvider.login：自己打开授权窗口
 * 或轮询凭据文件，返回登录后的账号 token。这里只负责把返回值归一化成渠道草稿。
 */
/**
 * 每日签到领积分（CodeBuddy / WorkBuddy）。插件不支持时返回明确错误，不抛。
 */
export async function claimAgentCredit(
  agentId: string,
  providerId: string,
): Promise<AgentCreditClaimResult> {
  try {
    const capabilities = await getAgentPluginRegistry().getCapabilities(agentId);
    if (capabilities.providerCheckin !== true) {
      return { success: false, error: "当前 Agent 不支持签到领积分。" };
    }
    // 签到接口用的是 CLI 登录态。Token 渠道没有独立账号目录，插件会回退到
    // 系统默认账号，导致“给 A 渠道签到、实际领到 B 账号”。这里直接拒绝。
    const listed = await listAgentConfig(agentId).catch(() => null);
    const provider = listed?.config?.providers?.find((item) => item.providerId === providerId);
    if (provider && String(provider.apiKey || "").trim()) {
      return {
        success: false,
        error: "该渠道使用 Token 登录，签到依赖 CLI 账号登录态，请切换到账号登录渠道。",
      };
    }
    const raw = await getAgentPluginRegistry().claimDailyCredit(agentId, providerId);
    const record = isRecord(raw) ? raw : {};
    const state = record.state === "signed" || record.state === "already" ? record.state : undefined;
    const credit = Number(record.credit);
    const base: {
      state?: "signed" | "already";
      credit?: number;
      message?: string;
      uid?: string;
      nickname?: string;
    } = {
      ...(state ? { state } : {}),
      ...(Number.isFinite(credit) ? { credit } : {}),
      ...(asString(record.message) ? { message: asString(record.message) } : {}),
      ...(asString(record.uid) ? { uid: asString(record.uid) } : {}),
      ...(asString(record.nickname) ? { nickname: asString(record.nickname) } : {}),
    };
    if (record.success === false) {
      return { success: false, error: asString(record.error) || "签到失败。", ...base };
    }
    return { success: true, ...base };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 每日自动领取积分的设置（存在 settings.json 的 creditCheckin 段）。 */
export interface CreditCheckinSettings {
  enabled: boolean;
  /** 24 小时制 HH:MM，当地时间。 */
  time: string;
  /** 最近一次自动执行日期（YYYY-MM-DD），用于一天只跑一次。 */
  lastRunDate?: string;
  lastResults?: Array<{
    agentId: string;
    providerId: string;
    displayName?: string;
    state?: string;
    credit?: number;
    error?: string;
  }>;
}

const CREDIT_CHECKIN_KEY = "creditCheckin";
const DEFAULT_CHECKIN_TIME = "08:05";

function normalizeCheckinTime(value: unknown): string {
  const text = asString(value);
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return DEFAULT_CHECKIN_TIME;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return DEFAULT_CHECKIN_TIME;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return DEFAULT_CHECKIN_TIME;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeCheckinSettings(value: unknown): CreditCheckinSettings {
  const record = isRecord(value) ? value : {};
  return {
    enabled: record.enabled === true,
    time: normalizeCheckinTime(record.time),
    ...(asString(record.lastRunDate) ? { lastRunDate: asString(record.lastRunDate) } : {}),
    ...(Array.isArray(record.lastResults) ? { lastResults: record.lastResults as CreditCheckinSettings["lastResults"] } : {}),
  };
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export async function getCreditCheckinSettings(): Promise<CreditCheckinSettings> {
  const settings = await readJsonObject(getSettingsPath());
  return normalizeCheckinSettings(settings[CREDIT_CHECKIN_KEY]);
}

export async function setCreditCheckinSettings(value: unknown): Promise<CreditCheckinSettings> {
  const next = normalizeCheckinSettings(value);
  await updateSettings((settings) => {
    settings[CREDIT_CHECKIN_KEY] = next;
  });
  return next;
}

/**
 * 对着所有支持签到的 Agent / 渠道各领一次。返回每个账号的结果。
 * 一天内重复调用是安全的：上游会回「今天已签到」。
 */
export async function runCreditCheckin(): Promise<{
  success: boolean;
  results: NonNullable<CreditCheckinSettings["lastResults"]>;
}> {
  const results: NonNullable<CreditCheckinSettings["lastResults"]> = [];
  try {
    const registry = getAgentPluginRegistry();
    const agents = await registry.listAgents();
    for (const agent of agents) {
      let capabilities: Awaited<ReturnType<typeof registry.getCapabilities>>;
      try {
        capabilities = await registry.getCapabilities(agent.id);
      } catch {
        continue;
      }
      if (capabilities.providerCheckin !== true) continue;
      let config: AgentProviderConfig[] = [];
      try {
        const listed = await listAgentConfig(agent.id);
        config = listed.config?.providers ?? [];
      } catch {
        continue;
      }
      for (const provider of config) {
        // Token 渠道没有独立 CLI 登录态，签到会落到系统默认账号；跳过。
        if (String(provider.apiKey || "").trim()) continue;
        const claimed = await claimAgentCredit(agent.id, provider.providerId);
        results.push({
          agentId: agent.id,
          providerId: provider.providerId,
          ...(provider.displayName ? { displayName: provider.displayName } : {}),
          ...(claimed.state ? { state: claimed.state } : {}),
          ...(claimed.credit !== undefined ? { credit: claimed.credit } : {}),
          ...(claimed.success ? {} : { error: claimed.error || "领取失败" }),
        });
      }
    }
  } catch (error) {
    results.push({
      agentId: "",
      providerId: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { success: results.every((item) => !item.error), results };
}

/** 每分钟检查一次：到了设定时间、今天还没跑过，就自动领取。 */
export function startCreditCheckinScheduler(): void {
  const tick = async () => {
    try {
      const settings = await getCreditCheckinSettings();
      if (!settings.enabled) return;
      const now = new Date();
      const today = localDateKey(now);
      if (settings.lastRunDate === today) return;
      const [hours, minutes] = settings.time.split(":").map((part) => Number(part));
      if (now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes) return;
      const { results } = await runCreditCheckin();
      await updateSettings((draft) => {
        const current = normalizeCheckinSettings(draft[CREDIT_CHECKIN_KEY]);
        draft[CREDIT_CHECKIN_KEY] = { ...current, lastRunDate: today, lastResults: results };
      });
    } catch {
      // 定时任务失败不打断主进程，下一分钟会再试（同一天会重复尝试，上游会拒绝重复领取）。
    }
  };
  void tick();
  setInterval(() => void tick(), 60_000).unref?.();
}

export async function loginAgentProvider(
  agentId: string,
  options: { force?: boolean; timeoutMs?: number; newAccount?: boolean } = {},
): Promise<AgentProviderLoginResult> {
  try {
    const capabilities = await getAgentPluginRegistry().getCapabilities(agentId);
    if (!capabilities.configuration || capabilities.configuration === "none") {
      return { success: false, error: "当前 Agent 不支持渠道配置。" };
    }
    if (capabilities.providerLogin !== true) {
      return { success: false, error: "当前 Agent 不支持账号登录。" };
    }
    const raw = await getAgentPluginRegistry().loginProvider(agentId, {
      force: options.force === true,
      ...(options.newAccount ? { newAccount: true } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const record = isRecord(raw) ? raw : {};
    const hint = asString(record.hint) || undefined;
    if (record.success === false) {
      return { success: false, error: asString(record.error) || "登录失败。", ...(hint ? { hint } : {}) };
    }
    const provider = normalizeProvider(record.provider, capabilities.configuration);
    if (!provider) {
      return { success: false, error: asString(record.error) || "登录已完成，但插件没有返回账号信息。", ...(hint ? { hint } : {}) };
    }
    return {
      success: true,
      ...(hint ? { hint } : {}),
      provider: {
        providerId: provider.providerId,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        authMode: provider.authMode,
        endpoint: provider.endpoint,
        models: provider.models,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
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
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      supportsImages: model.imageInput === true,
      ...(supportedThinkingLevels.length > 0 ? { supportedThinkingLevels } : {}),
      ...(thinkingLevelMode ? { thinkingLevelMode } : {}),
    };
  }));
}
