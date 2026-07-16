import type {
  AgentEvent,
  AgentImagePayload,
  AgentSendOptions,
  AgentUIResponse,
  AgentDescriptor,
  AgentPackageStatus,
  AgentPluginInstallResult,
  AgentPluginManifest,
  OfficialAgentPluginCatalogResult,
  OfficialAgentPluginDescriptor,
  AppUpdateResult,
  AppUpdateStatus,
} from "./ipc";
import type {
  RemoteAccessStatus,
  RemotePairingOffer,
  RemoteRendererCommand,
  RemoteRendererCommandResult,
  RemoteRendererPublish,
} from "../../shared/remote-protocol";

export type {
  RemoteAccessStatus,
  RemoteAgent,
  RemoteCatalogSnapshot,
  RemoteChatMessage,
  RemoteDeviceInfo,
  RemoteInteraction,
  RemotePairingOffer,
  RemoteProject,
  RemoteQueuedMessage,
  RemoteRendererCommand,
  RemoteRendererCommandResult,
  RemoteRendererPublish,
  RemoteServerEnvelope,
  RemoteSession,
  RemoteSessionConfig,
  RemoteSessionCreateResult,
} from "../../shared/remote-protocol";

export type {
  AgentEvent,
  AgentCapabilities,
  AgentBackendModelVisibility,
  AgentConfigurationSupport,
  AgentDescriptor,
  AgentImagePayload,
  AgentImagePayloadItem,
  AgentPackageStatus,
  AgentPlanModeSupport,
  AgentProviderConfiguration,
  AgentProviderEndpointOption,
  AgentProviderActivationSupport,
  AgentPluginInstallResult,
  AgentPluginManifest,
  AgentSource,
  AgentSendOptions,
  AgentUIResponse,
  OfficialAgentPluginCatalogResult,
  OfficialAgentPluginDescriptor,
  AppUpdateResult,
  AppUpdateState,
  AppUpdateStatus,
} from "./ipc";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileEntry[];
}

export interface PathAttachmentInfo {
  name: string;
  path: string;
  kind: "file" | "folder";
}

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  supportsImages?: boolean;
}

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
  models?: AgentModel[];
  reloadedSessionIds?: string[];
}

export interface AgentRemoteModel {
  id: string;
  name: string;
}

export interface AgentConfigFetchModelsResult {
  success: boolean;
  error?: string;
  models: AgentRemoteModel[];
}

export interface AgentModelVisibilityResult {
  success: boolean;
  error?: string;
  backendModelsVisible?: boolean;
  models?: AgentModel[];
}

export interface AgentForkTarget {
  newSessionId: string;
  sourceSessionFilePath?: string;
  sourceUserMessageIndex: number;
  rollbackUserMessageCount?: number;
  targetTurnId?: string;
  sourceMessageContent?: string;
  throughMessageId?: string;
}

export interface AgentForkResult {
  supported: boolean;
  success: boolean;
  sessionFilePath?: string;
  nativeEntryId?: string;
  error?: string;
  reason?: string;
}

export interface AgentReloadConfigResult {
  success: boolean;
  error?: string;
  models?: AgentModel[];
  reloadedSessionIds?: string[];
}

export type PiSDKStatus = AgentPackageStatus;

export interface ElectronAPI {
  // Window controls
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  platform: string;
  getAppVersion: () => Promise<string>;
  getAppUpdateStatus: () => Promise<AppUpdateStatus>;
  checkAppUpdate: () => Promise<AppUpdateResult>;
  downloadAppUpdate: () => Promise<AppUpdateResult>;
  installAppUpdate: () => Promise<AppUpdateResult>;
  getCloseToTray: () => Promise<boolean>;
  setCloseToTray: (enabled: boolean) => Promise<{ success: boolean }>;
  showNotification: (options: { title?: string; body?: string }) => Promise<{ success: boolean; error?: string }>;

  // File system
  readDirectory: (dirPath: string) => Promise<FileEntry[]>;
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  readFileDataUrl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  statPath: (filePath: string) => Promise<{ success: boolean; attachment?: PathAttachmentInfo; error?: string }>;
  getPathForFile: (file: File) => string;
  fileExists: (filePath: string) => Promise<boolean>;
  reverseApplyPatch: (projectPath: string, patches: string[]) => Promise<{ success: boolean; error?: string }>;
  searchFiles: (dirPath: string, query: string) => Promise<FileEntry[]>;
  openDirectory: () => Promise<{ canceled: boolean; path: string }>;
  openAttachmentFolder: () => Promise<{ canceled: boolean; attachment?: PathAttachmentInfo; error?: string }>;
  getHomeDir: () => Promise<string>;
  isCommandAvailable: (command: string) => Promise<boolean>;
  piSDKGetStatus: () => Promise<PiSDKStatus>;
  piSDKUpdate: () => Promise<{ success: boolean; error?: string; status?: PiSDKStatus }>;
  agentList: () => Promise<AgentDescriptor[]>;
  agentGetStatus: (agentId: string) => Promise<AgentPackageStatus>;
  agentUpdate: (agentId: string) => Promise<{ success: boolean; error?: string; status?: AgentPackageStatus }>;
  agentGetDefaultThinkingLevel: (agentId: string) => Promise<string>;
  agentPluginChoosePath: (kind?: "zip" | "directory") => Promise<{ canceled: boolean; path: string }>;
  agentPluginInstallFromPath: (pluginPath: string) => Promise<AgentPluginInstallResult>;
  agentPluginListOfficial: () => Promise<OfficialAgentPluginCatalogResult>;
  agentPluginInstallOfficial: (agentId: string) => Promise<AgentPluginInstallResult>;
  agentPluginRemove: (agentId: string, removeRuntime?: boolean) => Promise<AgentPluginInstallResult>;
  agentPluginReload: () => Promise<AgentPluginInstallResult>;

  // Data persistence
  loadData: (key: string) => Promise<unknown>;
  saveData: (key: string, data: unknown) => Promise<{ success: boolean; error?: string }>;
  remoteGetAccessStatus: () => Promise<RemoteAccessStatus>;
  remoteConfigureAccess: (patch: Partial<Pick<RemoteAccessStatus, "enabled" | "bindAddress" | "advertiseAddress" | "port">>) => Promise<RemoteAccessStatus>;
  remoteBeginPairing: () => Promise<RemotePairingOffer>;
  remoteRevokeDevice: (deviceId: string) => Promise<RemoteAccessStatus>;
  remotePublish: (update: RemoteRendererPublish) => void;
  remoteCommandResult: (result: RemoteRendererCommandResult) => void;
  onRemoteCommand: (callback: (command: RemoteRendererCommand) => void) => () => void;

  // Clipboard
  writeImageToClipboard: (imageDataUrl: string) => Promise<{ success: boolean; error?: string }>;

  // Agent
  agentCreateSession: (agentId: string, projectPath: string, sessionId?: string, sessionFilePath?: string) => Promise<{ success: boolean; error?: string; sessionFilePath?: string; models?: AgentModel[] }>;
  agentSwitchSession: (sessionId: string) => Promise<{ success: boolean }>;
  agentRemoveSession: (sessionId: string) => Promise<{ success: boolean }>;
  agentSendMessage: (message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) => Promise<{ success: boolean; error?: string }>;
  agentForkSession: (sessionId: string, target: AgentForkTarget) => Promise<AgentForkResult>;
  agentReloadConfig: (agentId: string, sessionId?: string) => Promise<AgentReloadConfigResult>;
  agentConfigList: (agentId: string) => Promise<AgentConfigResult>;
  agentConfigGetModelVisibility: (agentId: string) => Promise<AgentModelVisibilityResult>;
  agentConfigSetBackendModelsVisible: (agentId: string, visible: boolean) => Promise<AgentModelVisibilityResult>;
  agentConfigFetchModels: (baseUrl: string, apiKey: string) => Promise<AgentConfigFetchModelsResult>;
  agentConfigSave: (agentId: string, config: AgentProviderConfig) => Promise<AgentConfigResult>;
  agentConfigActivate: (agentId: string, providerId: string) => Promise<AgentConfigResult>;
  agentConfigDelete: (agentId: string, providerId: string) => Promise<AgentConfigResult>;
  agentConfigReorder: (agentId: string, providerIds: string[]) => Promise<AgentConfigResult>;
  agentSendGuidance: (message: string, images?: AgentImagePayload, sessionId?: string, options?: AgentSendOptions) => Promise<{ success: boolean; error?: string }>;
  agentAbort: (sessionId?: string) => Promise<{ success: boolean }>;
  agentGetModels: (sessionId?: string) => Promise<AgentModel[]>;
  agentSetModel: (provider: string, modelId: string, sessionId?: string) => Promise<{ success: boolean; error?: string }>;
  agentSetThinkingLevel: (level: string, sessionId?: string) => Promise<{ success: boolean }>;
  agentSendUIResponse: (response: AgentUIResponse) => Promise<{ success: boolean }>;

  // Agent events
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
  onAppUpdateStatus: (callback: (status: AppUpdateStatus) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
