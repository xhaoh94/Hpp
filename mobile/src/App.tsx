import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { BarcodeFormat, BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  GripVertical,
  History,
  Link2,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Menu,
  MessageCircle,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  Smartphone,
  Trash2,
  WandSparkles,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function renderAttachmentPreview(content: string, maxLength?: number) {
  let preview = content;
  if (maxLength && content.length > maxLength) {
    let cutoff = maxLength;
    const token = /\[(?:file|folder):[^\]]+\]/g;
    let match: RegExpExecArray | null;
    while ((match = token.exec(content))) {
      const end = match.index + match[0].length;
      if (match.index < cutoff && end > cutoff) cutoff = end;
      if (match.index >= cutoff) break;
    }
    preview = `${content.slice(0, cutoff)}...`;
  }
  return preview.split(/(\[(?:file|folder):[^\]]+\])/g).map((part, index) => {
    const match = part.match(/^\[(file|folder):\s*([^\]]+)\]$/);
    if (!match) return <span key={index}>{part}</span>;
    const kind = match[1];
    return <span className={`attachment-preview-token ${kind}`} key={index} title={match[2]}>
      {kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}<span>{match[2]}</span>
    </span>;
  });
}

function hydrateRemoteComposerDocument(
  document: RemoteComposerDocument | undefined,
  images: Array<{ id: string; src: string; name: string }> = [],
): ComposerDocument | undefined {
  if (!document) return undefined;
  const imageMap = new Map(images.map((image) => [image.id, image]));
  return createComposerDocument(document.nodes.flatMap((node): ComposerNode[] => {
    if (node.type !== "image") return [node];
    const image = imageMap.get(node.id);
    const src = node.src || image?.src;
    return src ? [{ ...node, src }] : [{ id: node.id, type: "text", text: `[image: ${node.name}]` }];
  }));
}

function remoteComposerDocument(document: ComposerDocument): RemoteComposerDocument {
  return {
    version: 1,
    nodes: document.nodes.map((node) => node.type === "image"
      ? { id: node.id, type: "image", name: node.name, mimeType: node.mimeType }
      : node),
  };
}
import type {
  RemoteCatalogSnapshot,
  RemoteAgent,
  RemoteAgentAction,
  RemoteAgentActionInvocation,
  RemoteChatMessage,
  RemoteInteraction,
  RemoteModel,
  RemoteProject,
  RemoteProcessEntry,
  RemoteQueuedMessage,
  RemoteComposerDocument,
  RemoteSession,
  RemoteSessionConfig,
  RemoteSessionCreateResult,
} from "@shared/remote-protocol";
import {
  composerDocumentHasContent,
  createComposerDocument,
  getComposerImageNodes,
  getComposerPlainText,
  withoutComposerImages,
  type ComposerDocument,
  type ComposerNode,
} from "@shared/composer-document";
import { InlineComposerEditor, type InlineComposerEditorHandle } from "../../src/components/shared/InlineComposerEditor";
import { ComposerMessageFlow } from "../../src/components/shared/ComposerMessageFlow";

const SESSION_RUNNING_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

function SessionRunningIndicator() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % SESSION_RUNNING_FRAMES.length), 80);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="session-running-indicator" title="运行中" aria-label="运行中">{SESSION_RUNNING_FRAMES[frame]}</span>;
}
import { MAX_REMOTE_IMAGES, MAX_REMOTE_SESSION_REFERENCES } from "@shared/remote-protocol";
import { formatModelSwitchToastText } from "@shared/model-switch";
import {
  getModelThinkingLevels,
  getThinkingLevelLabel,
  groupModelsByProvider,
  includeCurrentModel,
} from "@shared/models";
import { getAgentActionDisplayDescription } from "@shared/agent-actions";
import type { AgentPermissionMode } from "@shared/agent-permissions";
import {
  formatProcessDuration,
  getActiveAssistantTurnId,
  getProcessGroupState,
  getUserGuidanceText,
  getVisibleProcessEntries,
  groupProcessEntries,
  isAssistantNarrationProcessEntry,
  isProcessViewRunning,
  isUserGuidanceProcessEntry,
  normalizeProcessForView,
  splitCommandDetail,
  type ProcessTerminalViewState,
} from "@shared/process-view";
import { areAssistantMessageActionsVisible, formatHistoryMessageTime, formatMessageActionTime } from "@shared/message-display";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import { extractUserMessageAttachments } from "@shared/user-message-attachments";
import {
  chooseRemoteImage,
  getImageErrorMessage,
  isImageSelectionCancelled,
  type PendingRemoteImage,
} from "./images";
import { buildQuestionnaireAnswers, getQuestionnaireSummary, isQuestionnaireComplete } from "./questionnaire";
import {
  pairHost,
  probeHostAvailability,
  RemoteClient,
  withPreferredHostBaseUrl,
  type ConnectionState,
  type HostAvailability,
} from "./remote-client";
import {
  clearHostSessionDrafts,
  clearSessionDraft,
  loadLastPairedHostId,
  loadPairedHosts,
  loadSessionDraft,
  pruneSessionDrafts,
  saveLastPairedHostId,
  savePairedHosts,
  saveSessionDraft,
  withPairedHostMetadata,
  type MobileSessionDraft,
  type PairedHost,
} from "./storage";
import { copyText, createClientId } from "./web-platform";
import { useDragAutoScroll } from "../../src/hooks/useDragAutoScroll";
import { getComposerAction } from "./composer";
import { HppUpdater, type AndroidUpdaterDownloadStatus } from "./android-updater";
import {
  ANDROID_UPDATE_METADATA_MIRROR_URL,
  ANDROID_UPDATE_METADATA_URL,
  ANDROID_UPDATE_RELEASE_API_URL,
  getAndroidUpdateErrorMessage,
  isAndroidUpdateAvailable,
  parseGitHubReleaseUpdateMetadata,
  parseAndroidUpdateMetadata,
  type AndroidUpdateMetadata,
} from "./updater";
import mobilePackage from "../package.json";

type SessionPage = {
  sessionId: string;
  messages: RemoteChatMessage[];
  nextBefore: number | null;
  revision: number;
  queue: RemoteQueuedMessage[];
  interaction: RemoteInteraction | null;
  config: RemoteSessionConfig | null;
};

export function isSessionPageResponseCurrent(
  pageRevision: number,
  requiredRevision: number,
  requestUnrevisionedEventVersion: number,
  currentUnrevisionedEventVersion: number,
) {
  return pageRevision >= requiredRevision &&
    requestUnrevisionedEventVersion === currentUnrevisionedEventVersion;
}

type PairingMode = "closed" | "manual";
type ComposerDraftValue = Pick<MobileSessionDraft, "text" | "document" | "referenceSessionIds" | "action">;
type AndroidUpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "permission"
  | "installing"
  | "up-to-date"
  | "error";

const IS_NATIVE_APP = Capacitor.isNativePlatform();
const DEMO_SESSION_ID = "demo-session";
const DEMO_HOST: PairedHost = {
  id: "demo-host",
  hostId: "demo-host",
  hostName: "Studio Desktop",
  baseUrl: "http://192.168.1.20:47831",
  deviceId: "demo-device",
  token: "demo-token",
};
const DEMO_PROJECTS: RemoteProject[] = [{
  id: "demo-project",
  name: "hpp",
  createdAt: new Date().toISOString(),
  sessions: [
    {
      id: DEMO_SESSION_ID,
      agentId: "codex",
      title: "优化 Android 竖屏布局",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      closed: false,
      status: "running",
    },
    {
      id: "demo-session-2",
      agentId: "pi",
      title: "远程协议检查",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date(Date.now() - 3600_000).toISOString(),
      closed: false,
      status: "completed",
    },
    {
      id: "demo-session-3",
      agentId: "opencode",
      title: "旧的发布任务",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date(Date.now() - 86_400_000).toISOString(),
      closed: true,
      status: "idle",
    },
  ],
}];
const DEMO_MESSAGES: RemoteChatMessage[] = [
  {
    id: "demo-user-message",
    role: "user",
    content: "把移动端重新按竖屏设计，聊天区域尽量舒服，常用控制不要占太多高度。",
    timestamp: Date.now() - 75_000,
  },
  {
    id: "demo-assistant-message",
    role: "assistant",
    content: "我会合并顶部信息层级，并让模型、Thinking 和 Plan 控制保持在一行。输入区会根据内容自动增高。",
    timestamp: Date.now() - 60_000,
    isStreaming: true,
    process: {
      startedAt: Date.now() - 58_000,
      planSteps: [
        { id: "demo-plan-1", title: "压缩会话顶部信息", status: "completed" },
        { id: "demo-plan-2", title: "优化消息与输入区", status: "running" },
      ],
      entries: [
        { id: "demo-tool-1", type: "tool", title: "读取移动端布局", timestamp: Date.now() - 55_000, state: "completed", files: [{ file: "mobile/src/App.tsx" }] },
        { id: "demo-command-1", type: "tool", toolKind: "run_command", title: "已运行 npm test", command: "npm test", timestamp: Date.now() - 45_000, state: "completed" },
        { id: "demo-command-2", type: "tool", toolKind: "run_command", title: "已运行 npm run mobile:build", command: "npm run mobile:build", timestamp: Date.now() - 35_000, state: "completed" },
        { id: "demo-tool-2", type: "thinking", title: "正在调整竖屏密度", timestamp: Date.now() - 20_000, state: "running", detail: "Keep the conversation readable while preserving controls." },
      ],
    },
    diffs: [{ file: "mobile/src/styles.css", patch: "@@ mobile portrait layout\n+ compact toolbar\n+ adaptive composer", additions: 42, deletions: 18 }],
  },
];
const DEMO_CONFIG: RemoteSessionConfig = {
  model: { id: "gpt-5.6", name: "GPT-5.6", provider: "openai", reasoning: true, supportsImages: true },
  thinkingLevel: "high",
  planModeEnabled: true,
  permissionMode: "auto",
  availableModels: [
    { id: "gpt-5.6", name: "GPT-5.6", provider: "openai", reasoning: true, supportsImages: true },
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", reasoning: true, supportsImages: true },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "openrouter", reasoning: true, supportsImages: true },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", reasoning: true, supportsImages: true },
  ],
};
const DEMO_AGENTS: RemoteAgent[] = [
  { id: "codex", name: "Codex", description: "OpenAI Codex agent", runtime: "cli", requiresProviderActivation: true, supportsGuidance: true, supportsActions: true, supportsPermissions: true },
  { id: "pi", name: "Pi", description: "Pi coding agent", runtime: "sdk", supportsGuidance: true, supportsPermissions: true },
  { id: "opencode", name: "OpenCode", description: "OpenCode agent", runtime: "cli" },
];
const DEMO_ACTIONS: RemoteAgentAction[] = [
  { kind: "skill", name: "frontend-design", description: "优化前端布局、视觉细节和交互体验。" },
  { kind: "skill", name: "review", description: "检查当前改动中的错误、风险和缺失测试。" },
  { kind: "command", name: "test", description: "运行当前项目的测试。", argumentHint: "测试名称（可选）" },
];

async function requestAndroidUpdateJson(url: string) {
  const separator = url.includes("?") ? "&" : "?";
  const requestUrl = `${url}${separator}t=${Date.now()}`;
  let nativeFailure: unknown;
  try {
    const response = await CapacitorHttp.get({
      url: requestUrl,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "Hpp-Android-Updater",
      },
      connectTimeout: 12_000,
      readTimeout: 12_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`UPDATE_CHECK_HTTP_${response.status}`);
    }
    return response.data as unknown;
  } catch (error) {
    nativeFailure = error;
  }

  try {
    const response = await fetch(requestUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`UPDATE_CHECK_HTTP_${response.status}`);
    return await response.json() as unknown;
  } catch {
    throw nativeFailure;
  }
}

async function fetchAndroidUpdateMetadata() {
  let lastFailure: unknown;
  for (const url of [ANDROID_UPDATE_METADATA_URL, ANDROID_UPDATE_METADATA_MIRROR_URL]) {
    try {
      return parseAndroidUpdateMetadata(await requestAndroidUpdateJson(url));
    } catch (error) {
      lastFailure = error;
    }
  }
  try {
    return parseGitHubReleaseUpdateMetadata(
      await requestAndroidUpdateJson(ANDROID_UPDATE_RELEASE_API_URL),
    );
  } catch (error) {
    throw lastFailure || error;
  }
}

function findSession(projects: RemoteProject[], sessionId: string | null) {
  if (!sessionId) return null;
  for (const project of projects) {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return { project, session };
  }
  return null;
}

function connectionLabel(state: ConnectionState) {
  if (state === "connected") return "已连接";
  if (state === "connecting") return "正在连接";
  if (state === "unauthorized") return "配对已失效";
  return "已断开";
}

function hostAvailabilityLabel(state: HostAvailability) {
  if (state === "online") return "在线";
  if (state === "offline") return "离线";
  return "检测中";
}

function MobileModelPicker({
  agentName,
  currentModel,
  models,
  disabled,
  onSelect,
}: {
  agentName: string;
  currentModel: RemoteModel | null;
  models: RemoteModel[];
  disabled: boolean;
  onSelect: (model: RemoteModel) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(currentModel?.provider || null);
  const modelsByProvider = useMemo(() => {
    return groupModelsByProvider(models);
  }, [models]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const providers = Array.from(modelsByProvider.keys());
  const menuStyle = useAnchoredOverlay(open, rootRef, menuRef);
  return (
    <div ref={rootRef} className={`model-picker ${open ? "open" : ""}`}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled || models.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => {
            if (!current) setExpandedProvider(currentModel?.provider || providers[0] || null);
            return !current;
          });
        }}
      >
        <Bot size={14} />
        <span>{currentModel?.name || "选择模型"}</span>
        <ChevronDown size={13} />
      </button>
      {open && createPortal(
        <div ref={menuRef} style={menuStyle} className="model-picker-menu" role="dialog" aria-label={`${agentName} 模型`}>
          <div className="model-picker-header">
            <strong>{agentName} 模型</strong>
            <span>{models.length} 个可用</span>
          </div>
          {providers.map((provider) => {
            const providerModels = modelsByProvider.get(provider) || [];
            const expanded = expandedProvider === provider;
            const activeProvider = currentModel?.provider === provider;
            return (
              <div className={`model-provider-group ${expanded ? "expanded" : ""}`} key={provider}>
                <button
                  type="button"
                  className={`model-provider ${activeProvider ? "active" : ""}`}
                  aria-expanded={expanded}
                  onClick={() => setExpandedProvider(expanded ? null : provider)}
                >
                  <ChevronRight className="model-provider-chevron" size={14} />
                  <span>{provider}</span>
                  <small>{providerModels.length}</small>
                </button>
                {expanded && providerModels.map((model) => {
                  const active = model.id === currentModel?.id && model.provider === currentModel.provider;
                  return (
                    <button
                      type="button"
                      className={`model-option ${active ? "active" : ""}`}
                      key={`${model.provider}:${model.id}`}
                      onClick={() => {
                        setOpen(false);
                        onSelect(model);
                      }}
                    >
                      <span>{model.name}</span>
                      {active && <em>当前</em>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

function MobileThinkingPicker({
  value,
  levels,
  disabled,
  onSelect,
}: {
  value: string;
  levels: ReturnType<typeof getModelThinkingLevels>;
  disabled: boolean;
  onSelect: (level: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const currentLevel = levels.find((level) => level.id === value)
    || levels.find((level) => level.id === "medium")
    || levels[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const menuStyle = useAnchoredOverlay(open, rootRef, menuRef);
  return (
    <div ref={rootRef} className={`thinking-picker ${open ? "open" : ""}`}>
      <button
        type="button"
        className="thinking-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Lightbulb size={14} />
        <span>{currentLevel?.label || getThinkingLevelLabel(value)}</span>
        <ChevronDown size={10} />
      </button>
      {open && createPortal(
        <div ref={menuRef} style={menuStyle} className="thinking-picker-menu" role="listbox" aria-label="思考等级">
          {levels.map((level) => (
            <button
              type="button"
              role="option"
              aria-selected={level.id === value}
              className={`thinking-option ${level.id === value ? "active" : ""}`}
              key={level.id}
              onClick={() => {
                setOpen(false);
                onSelect(level.id);
              }}
            >
              <span>{level.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function MobilePermissionPicker({
  value,
  disabled,
  onSelect,
}: {
  value: AgentPermissionMode;
  disabled: boolean;
  onSelect: (mode: AgentPermissionMode) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const options: Array<{
    mode: AgentPermissionMode;
    label: string;
    description: string;
    icon: typeof Shield;
  }> = [
    { mode: "ask", label: "请求权限", description: "敏感操作执行前都先询问", icon: Shield },
    { mode: "auto", label: "自动权限", description: "低风险自动执行，高风险先询问", icon: ShieldCheck },
    { mode: "full-access", label: "完全访问", description: "不再询问，可执行高风险操作", icon: ShieldAlert },
  ];
  const selected = options.find((option) => option.mode === value) || options[1];
  const SelectedIcon = selected.icon;
  const menuStyle = useAnchoredOverlay(open, rootRef, menuRef);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className={`permission-picker ${open ? "open" : ""}`}>
      <button
        type="button"
        className={`permission-picker-trigger ${value === "full-access" ? "danger" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="设置 Agent 权限"
        onClick={() => setOpen((current) => !current)}
      >
        <SelectedIcon size={14} />
        <span>{selected.label}</span>
        <ChevronDown size={10} />
      </button>
      {open && createPortal(
        <div ref={menuRef} style={menuStyle} className="permission-picker-menu" role="menu" aria-label="Agent 权限模式">
          <strong>Agent 权限</strong>
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={option.mode === value}
                className={`permission-option ${option.mode === value ? "active" : ""} ${option.mode === "full-access" ? "danger" : ""}`}
                key={option.mode}
                onClick={() => {
                  setOpen(false);
                  onSelect(option.mode);
                }}
              >
                <Icon size={16} />
                <span><b>{option.label}</b><small>{option.description}</small></span>
                {option.mode === value && <Check className="permission-check" size={14} />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

type AgentActionSheetProps = {
  agentId?: string;
  actions: RemoteAgentAction[];
  selectedAction?: RemoteAgentActionInvocation;
  loading: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (action: RemoteAgentActionInvocation) => void;
};

function AgentActionSheet({
  agentId,
  actions,
  selectedAction,
  loading,
  error,
  onClose,
  onRefresh,
  onSelect,
}: AgentActionSheetProps) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLowerCase();
  const visibleActions = actions.filter((entry) => {
    const description = getAgentActionDisplayDescription(agentId, entry);
    return !normalizedSearch
      || `${entry.name} ${description} ${entry.description || ""}`.toLowerCase().includes(normalizedSearch);
  });
  const skills = visibleActions.filter((entry) => entry.kind === "skill");
  const commands = visibleActions.filter((entry) => entry.kind === "command");

  const renderGroup = (label: string, entries: RemoteAgentAction[], divided = false) => entries.length > 0 && (
    <>
      <div className={`action-sheet-group${divided ? " divided" : ""}`}>{label}</div>
      {entries.map((entry) => {
        const active = selectedAction?.kind === entry.kind && selectedAction.name === entry.name;
        const description = getAgentActionDisplayDescription(agentId, entry);
        return (
          <button
            type="button"
            className={`action-sheet-item${active ? " active" : ""}`}
            key={`${entry.kind}:${entry.name}`}
            onClick={() => onSelect({ kind: entry.kind, name: entry.name })}
          >
            {entry.kind === "skill" ? <WandSparkles size={16} /> : <span className="action-sheet-command">/</span>}
            <span>
              <strong>{entry.name}</strong>
              {description && <small>{description}</small>}
            </span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className="bottom-sheet action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="选择技能或命令"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-title">
          <div><h2>技能与命令</h2><p>选择后可继续输入参数或说明</p></div>
          <div className="action-sheet-title-actions">
            <button type="button" className="icon-button" onClick={onRefresh} disabled={loading} title="刷新技能列表" aria-label="刷新技能列表">
              <RefreshCw className={loading ? "spin" : undefined} size={17} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button>
          </div>
        </div>
        <label className="action-sheet-search">
          <Search size={14} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索技能或命令" autoFocus />
        </label>
        <div className="action-sheet-list">
          {loading && actions.length === 0 ? (
            <div className="action-sheet-state"><LoaderCircle className="spin" size={16} />正在读取技能</div>
          ) : error ? (
            <div className="action-sheet-state error">{error}</div>
          ) : visibleActions.length === 0 ? (
            <div className="action-sheet-state">{normalizedSearch ? "没有匹配的技能或命令" : "当前 Agent 没有可用的技能或命令"}</div>
          ) : (
            <>
              {renderGroup("技能", skills)}
              {renderGroup("命令", commands, skills.length > 0)}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function IdleDurationLabel({ entry }: { entry: RemoteProcessEntry }) {
  // Only a running stream_idle_notice entry needs the ticking clock; a
  // completed one renders a static duration. Keeping the ticker inside this
  // tiny leaf means the per-second nowTick no longer invalidates every
  // ProcessEntryRow (previously it re-rendered all process entries each
  // second while an agent turn was running).
  const ticking = entry.toolKind === "stream_idle_notice" && !!entry.startedAt && !entry.completedAt;
  const nowTick = useProcessTicker(ticking);
  const idleDuration = entry.toolKind === "stream_idle_notice" && entry.startedAt
    ? formatIdleDuration((entry.completedAt ?? nowTick) - entry.startedAt)
    : null;
  if (!idleDuration) return null;
  return <span className="process-idle-duration"> · {idleDuration}</span>;
}

const ProcessEntryRow = memo(function ProcessEntryRow({
  entry,
  receivedMessageDocument,
}: {
  entry: RemoteProcessEntry;
  receivedMessageDocument?: ComposerDocument;
}) {
  if (entry.type === "subagent" && entry.subagents?.length) {
    return <SubagentProcessEntry entry={entry} />;
  }
  if (isAssistantNarrationProcessEntry(entry)) {
    return (
      <MarkdownContent className="message-commentary-item message-content" text={entry.detail || entry.title} />
    );
  }
  if (isUserGuidanceProcessEntry(entry)) {
    const sourceDocument = hydrateRemoteComposerDocument(entry.guidanceDocument, entry.guidanceImages);
    const guidanceDocument = sourceDocument ? withoutComposerImages(sourceDocument) : undefined;
    const documentImages = sourceDocument ? getComposerImageNodes(sourceDocument) : [];
    const guidanceImages = entry.guidanceImages?.length ? entry.guidanceImages : documentImages;
    const hasDocumentContent = !!guidanceDocument && composerDocumentHasContent(guidanceDocument);
    const fallbackText = !hasDocumentContent && (!sourceDocument || guidanceImages.length === 0)
      ? getUserGuidanceText(entry)
      : "";

    return (
      <div className="process-guidance-row">
        <div className="process-guidance-stack">
          {guidanceImages.length > 0 && (
            <div className="process-guidance-images">
              {guidanceImages.map((image) => <img key={image.id} src={image.src} alt={image.name} />)}
            </div>
          )}
          <div className="process-guidance-content">
            <span className="process-guidance-label" title="引导">
              <CornerDownRight size={14} strokeWidth={2} />
            </span>
            <div className="message-user-bubble process-guidance-bubble">
              {hasDocumentContent && guidanceDocument ? (
                <ComposerMessageFlow document={guidanceDocument} />
              ) : fallbackText ? (
                <span className="process-guidance-text">{fallbackText}</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }
  const isReceivedMessage = entry.toolKind === "message_received" || entry.title.startsWith("收到消息:");
  if (isReceivedMessage && receivedMessageDocument) {
    return (
      <div className={`process-entry process-entry-static ${entry.type}`}>
        <div className="process-entry-summary process-entry-received">
          <span className={`entry-state ${entry.state || "completed"}`} />
          <span className="process-entry-received-content">
            <span className="process-entry-received-label">收到消息：</span>
            <ComposerMessageFlow document={receivedMessageDocument} />
          </span>
        </div>
      </div>
    );
  }
  const hasDetails = Boolean(entry.detail?.trim() || entry.files?.length);
  const row = (
    <>
      <span className={`entry-state ${entry.state || "completed"}`} />
      <span className="process-entry-title" title={entry.title}>
        {entry.title}
        <IdleDurationLabel entry={entry} />
      </span>
      {hasDetails && <ChevronDown className="expand-indicator" size={13} />}
    </>
  );
  if (!hasDetails) {
    return <div className={`process-entry process-entry-static ${entry.type}`}><div className="process-entry-summary">{row}</div></div>;
  }
  return (
    <details className={`process-entry ${entry.type}`}>
      <summary className="process-entry-summary">{row}</summary>
      {entry.command && <pre><code>{entry.command}</code></pre>}
      {entry.detail && (entry.type === "thinking" ? (
        <MarkdownContent className="process-entry-detail message-content" text={entry.detail} />
      ) : <pre>{entry.detail}</pre>)}
      {entry.files && entry.files.length > 0 && (
        <div className="process-files">
          {entry.files.map((file, index) => <code key={`${String(file.file)}-${index}`}>{String(file.file || "file")}</code>)}
        </div>
      )}
    </details>
  );
});

function CommandGroup({ entries }: { entries: RemoteProcessEntry[] }) {
  const groupState = getProcessGroupState(entries);
  return (
    <details className="process-entry command-group">
      <summary className="process-entry-summary command-group-summary">
        <span className={`entry-state ${groupState}`} />
        <span className="process-entry-title">已运行 {entries.length} 条命令</span>
        <ChevronDown className="expand-indicator" size={13} />
      </summary>
      <div className="command-group-list">
        {entries.map((entry) => {
          const { command, output } = splitCommandDetail(entry);
          const title = command || entry.title;
          if (!output) return <div className="command-group-item static" key={entry.id}>{title}</div>;
          return (
            <details className="command-group-item" key={entry.id}>
              <summary><span>{title}</span><ChevronDown className="expand-indicator" size={12} /></summary>
              <pre>{output}</pre>
            </details>
          );
        })}
      </div>
    </details>
  );
}

function MessageCommentary({
  items,
  running,
}: {
  items: NonNullable<RemoteChatMessage["commentary"]>;
  running: boolean;
}) {
  return (
    <div className="message-commentary message-content" aria-label="处理说明">
      {items.map((item) => (
        <MarkdownContent
          className={`message-commentary-item${running && item.isStreaming ? " streaming" : ""}`}
          text={item.content}
          key={item.id}
        />
      ))}
    </div>
  );
}

function FileOperationGroup({ entries }: { entries: RemoteProcessEntry[] }) {
  const files = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    for (const file of entry.files || []) {
      const filePath = typeof file.file === "string" ? file.file : "";
      if (!filePath) continue;
      files.set(filePath.replace(/\\/g, "/").toLowerCase(), file);
    }
  }
  const mergedFiles = Array.from(files.values());
  const state = getProcessGroupState(entries);
  const running = state === "running";
  const toolKind = entries[0]?.toolKind;
  const action = toolKind === "read_file"
    ? running ? "正在读取" : "已读取"
    : toolKind === "list_dir"
      ? running ? "正在查看" : "已查看"
      : toolKind === "write_file"
        ? running ? "正在写入" : "已写入"
        : running ? "正在编辑" : "已编辑";
  const unit = toolKind === "list_dir" ? "个目录" : "个文件";
  const warningTitle = entries.find((entry) => entry.state === "warning" || entry.state === "error")?.title;
  return (
    <ProcessEntryRow
      entry={{
        ...entries[entries.length - 1],
        id: `files-${entries[0].id}`,
        title: warningTitle || `${action} ${mergedFiles.length} ${unit}`,
        state,
        files: mergedFiles,
        detail: undefined,
      }}
    />
  );
}

function SubagentProcessEntry({ entry }: { entry: RemoteProcessEntry }) {
  const messages = (entry.subagents || [])
    .map((subagent) => subagent.message?.trim())
    .filter((message): message is string => !!message && message !== entry.detail?.trim());
  const detail = [entry.detail?.trim(), ...new Set(messages)].filter(Boolean).join("\n\n");
  const hasDetails = Boolean(detail || entry.files?.length);
  const summary = (
    <>
      <span className="subagent-entry-content">
        <span className="subagent-chip-list">
          {entry.subagents!.map((subagent) => {
            const status = subagent.status || "pending";
            const statusLabel = getSubagentStatusLabel(status);
            const description = [statusLabel, subagent.model, subagent.path, subagent.message].filter(Boolean).join(" · ");
            return (
              <span
                className={`subagent-chip ${status}`}
                key={subagent.id}
                title={description || subagent.label}
              >
                <span className={`subagent-avatar tone-${getSubagentTone(subagent.id)}`}>
                  <SubagentGlyph />
                </span>
                <span>{subagent.label}</span>
              </span>
            );
          })}
        </span>
        {entry.title && <span className="subagent-entry-title">{entry.title}</span>}
      </span>
      {hasDetails && <ChevronDown className="expand-indicator" size={13} />}
    </>
  );
  if (!hasDetails) {
    return (
      <div className="process-entry process-entry-static subagent-entry">
        <div className="process-entry-summary subagent-entry-summary">{summary}</div>
      </div>
    );
  }
  return (
    <details className="process-entry subagent-entry">
      <summary className="process-entry-summary subagent-entry-summary">{summary}</summary>
      {detail && (
        <MarkdownContent className="subagent-entry-detail message-content" text={detail} />
      )}
      {entry.files && entry.files.length > 0 && (
        <div className="process-files">
          {entry.files.map((file, index) => <code key={`${String(file.file)}-${index}`}>{String(file.file || "file")}</code>)}
        </div>
      )}
    </details>
  );
}

function getSubagentTone(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 4;
}

function getSubagentStatusLabel(status?: NonNullable<RemoteProcessEntry["subagents"]>[number]["status"]) {
  switch (status) {
    case "pending": return "等待中";
    case "running": return "工作中";
    case "completed": return "已完成";
    case "error": return "失败";
    case "interrupted": return "已中断";
    default: return "";
  }
}

export const formatIdleDuration = (ms: number) => {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

function SubagentGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 1.8l1.6 3.1 3.45-.55-.55 3.45 3.1 1.6-3.1 1.6.55 3.45-3.45-.55L10 17.2l-1.6-3.3-3.45.55.55-3.45-3.1-1.6 3.1-1.6-.55-3.45 3.45.55L10 1.8z"
        fill="currentColor"
        fillOpacity="0.3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="9.5" r="2.2" fill="currentColor" />
    </svg>
  );
}

function useProcessTicker(enabled: boolean) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return now;
}

const MarkdownContent = memo(function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className || "message-content"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{text}</ReactMarkdown>
    </div>
  );
});

function MessageProcess({
  message,
  receivedUserMessage,
  running,
  terminalState,
}: {
  message: RemoteChatMessage;
  receivedUserMessage?: RemoteChatMessage;
  running: boolean;
  terminalState: ProcessTerminalViewState;
}) {
  const receivedMessageDocument = hydrateRemoteComposerDocument(
    receivedUserMessage?.composerDocument,
    receivedUserMessage?.images,
  );
  const processStartedAt = message.process?.startedAt;
  const commentary = (message.commentary || []).filter((item) => item.content.trim());
  const fallbackEndedAt = Math.max(message.timestamp, ...commentary.map((item) => item.timestamp));
  const process = useMemo(() => message.process ? normalizeProcessForView(message.process, {
    running,
    terminalState,
    fallbackEndedAt,
  }) : undefined, [fallbackEndedAt, message.process, running, terminalState]);
  const processRunning = !!process && isProcessViewRunning(process, running);
  const nowTick = useProcessTicker(processRunning);
  const [expanded, setExpanded] = useState(running && message.isStreaming === true);
  const processStartedAtRef = useRef(processStartedAt);
  useEffect(() => {
    if (processStartedAt && processStartedAt !== processStartedAtRef.current) {
      processStartedAtRef.current = processStartedAt;
      setExpanded(running && message.isStreaming === true);
    }
  }, [message.isStreaming, processStartedAt, running]);
  const visibleEntries = useMemo(() => getVisibleProcessEntries(process?.entries || []), [process?.entries]);
  const timelineItems = useMemo(() => [
    ...visibleEntries.map((entry, index) => ({
      kind: "entry" as const,
      id: entry.id,
      timestamp: entry.timestamp,
      order: index,
      entry,
    })),
    ...commentary.map((item, index) => ({
      kind: "commentary" as const,
      id: item.id,
      timestamp: item.timestamp,
      order: visibleEntries.length + index,
      commentary: item,
    })),
  ].sort((left, right) => left.timestamp - right.timestamp || left.order - right.order), [commentary, visibleEntries]);
  if (!process) return commentary.length > 0 ? <MessageCommentary items={commentary} running={running} /> : null;
  const elapsed = formatProcessDuration((process.endedAt ?? nowTick) - process.startedAt);
  const hasPlan = !!process.planSteps?.length;
  if (!hasPlan && visibleEntries.length === 0 && !process.changeSummary) {
    return commentary.length > 0 ? <MessageCommentary items={commentary} running={running} /> : null;
  }
  return (
    <>
      <details className="process-block" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <span>处理耗时 {elapsed}</span>
          <span className="process-summary-meta">
            {process.changeSummary && (
              <small>
                {process.changeSummary.filesChanged} files · +{process.changeSummary.additions} -{process.changeSummary.deletions}
              </small>
            )}
            <ChevronDown className="expand-indicator" size={14} />
          </span>
        </summary>
        {hasPlan && (
          <div className="process-plan">
            {process.planSteps!.map((step) => (
              <div key={step.id} data-status={step.status}><span /><span className="process-plan-title">{step.title}</span></div>
            ))}
          </div>
        )}
        {commentary.length === 0 && visibleEntries.length > 0 && (
          <div className="process-entries">
            {groupProcessEntries(visibleEntries, { groupFileOperations: true }).map((group) => group.kind === "commands"
              ? <CommandGroup key={`commands-${group.entries[0].id}`} entries={group.entries} />
              : group.kind === "files"
                ? <FileOperationGroup key={`files-${group.entries[0].id}`} entries={group.entries} />
                : <ProcessEntryRow key={group.entry.id} entry={group.entry} receivedMessageDocument={receivedMessageDocument} />)}
          </div>
        )}
      </details>
      {commentary.length > 0 && expanded && (
        <div className="message-turn-timeline">
          {timelineItems.map((item) => item.kind === "commentary" ? (
            <MarkdownContent
              className={`message-commentary-item message-content${processRunning && item.commentary.isStreaming ? " streaming" : ""}`}
              text={item.commentary.content}
              key={`commentary-${item.id}`}
            />
          ) : (
            <ProcessEntryRow key={`process-${item.id}`} entry={item.entry} receivedMessageDocument={receivedMessageDocument} />
          ))}
        </div>
      )}
    </>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  receivedUserMessage,
  turnRunning,
  processTerminalState,
  actionsDisabled,
  forking,
  onEdit,
  onCopy,
  onFork,
}: {
  message: RemoteChatMessage;
  receivedUserMessage?: RemoteChatMessage;
  turnRunning: boolean;
  processTerminalState: ProcessTerminalViewState;
  actionsDisabled: boolean;
  forking: boolean;
  onEdit: (content: string) => void;
  onCopy: (content: string) => void;
  onFork: (message: RemoteChatMessage) => void;
}) {
  const messagePresentation = message.role === "user"
    ? extractUserMessageAttachments(message.content)
    : { text: message.content, attachments: [] };
  const fallbackProcessEndedAt = Math.max(
    message.timestamp,
    ...(message.commentary || []).map((item) => item.timestamp),
  );
  const processRunning = !!message.process && isProcessViewRunning(message.process, turnRunning);
  const assistantActionsReady = areAssistantMessageActionsVisible({
    ...message,
    isStreaming: turnRunning && message.isStreaming,
    process: message.process ? {
      ...message.process,
      endedAt: processRunning ? message.process.endedAt : message.process.endedAt ?? fallbackProcessEndedAt,
    } : undefined,
  });
  const showActions = message.role === "user" || assistantActionsReady;
  const sourceComposerDocument = message.role === "user"
    ? hydrateRemoteComposerDocument(message.composerDocument, message.images)
    : undefined;
  const orderedDocument = sourceComposerDocument ? withoutComposerImages(sourceComposerDocument) : undefined;
  const displayedImages = message.images?.length
    ? message.images
    : sourceComposerDocument
      ? getComposerImageNodes(sourceComposerDocument).map(({ id, src, name }) => ({ id, src, name }))
      : [];
  const hasOrderedContent = !!orderedDocument && composerDocumentHasContent(orderedDocument);
  const hasLegacyTextContent = !orderedDocument && !!messagePresentation.text;
  const hasUserBubbleContent = message.role === "user" && (
    hasLegacyTextContent
    || messagePresentation.attachments.length > 0
    || !!message.sessionReferences?.length
    || !!message.action
    || hasOrderedContent
  );
  return (
    <article id={`message-${message.id}`} className={`message ${message.role}`}>
      {message.role === "system" && (
        <div className="message-meta">
          <span>System</span>
          <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
      )}
      {displayedImages.length > 0 && (
        <div className="message-images">
          {displayedImages.map((image) => <img key={image.id} src={image.src} alt={image.name} />)}
        </div>
      )}
      {hasUserBubbleContent && (
        <div className="message-user-bubble">
          {message.action && (
            <div className={`message-action-label${messagePresentation.text ? " with-content" : ""}`}>
              <WandSparkles size={13} />
              <span>{message.action.kind === "skill" ? "技能" : "命令"}</span>
              <strong>{message.action.name}</strong>
            </div>
          )}
          {(hasOrderedContent || messagePresentation.attachments.length > 0 || !!message.sessionReferences?.length || hasLegacyTextContent) && (
            <div className="message-user-flow">
              {orderedDocument ? (
                <ComposerMessageFlow document={orderedDocument} />
              ) : (
                <>
              {messagePresentation.attachments.map((attachment, index) => (
                <span className={`message-text-attachment-chip ${attachment.kind}`} key={`${attachment.kind}:${attachment.label}:${index}`}>
                  {attachment.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}
                  <span>{attachment.label}</span>
                </span>
              ))}
              {message.sessionReferences?.map((reference) => (
                <span className="message-reference-chip" key={reference.sourceSessionId}>
                  <Link2 size={11} />
                  <span>引用会话: {renderAttachmentPreview(reference.sourceTitle)}</span>
                </span>
              ))}
              {messagePresentation.text && (
                <div className="message-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{messagePresentation.text}</ReactMarkdown>
                </div>
              )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {message.role !== "user" && message.sessionReferences && message.sessionReferences.length > 0 && (
        <div className={`message-reference-list ${message.role}`} aria-label="引用会话">
          {message.sessionReferences.map((reference) => (
            <span className="message-reference-chip" key={reference.sourceSessionId}>
              <Link2 size={11} />
              <span>引用会话: {renderAttachmentPreview(reference.sourceTitle)}</span>
            </span>
          ))}
        </div>
      )}
      <MessageProcess message={message} receivedUserMessage={receivedUserMessage} running={turnRunning} terminalState={processTerminalState} />
      {message.role !== "user" && message.action && (
        <div className={`message-action-label${messagePresentation.text ? " with-content" : ""}`}>
          <WandSparkles size={13} />
          <span>{message.action.kind === "skill" ? "技能" : "命令"}</span>
          <strong>{message.action.name}</strong>
        </div>
      )}
      {message.role !== "user" && messagePresentation.text && (
        <MarkdownContent text={messagePresentation.text} />
      )}
      {showActions && (
        <div className={`message-actions ${message.role}`}>
          {message.role === "user" && (
            <time className="message-action-time">{formatMessageActionTime(message.timestamp)}</time>
          )}
          {message.role === "user" && (
            <button type="button" onClick={() => onEdit(message.content)} disabled={actionsDisabled || !message.content} title="编辑" aria-label="编辑">
              <Pencil size={15} />
            </button>
          )}
          <button type="button" onClick={() => onCopy(message.content)} disabled={!message.content} title="复制" aria-label="复制">
            <Copy size={15} />
          </button>
          {assistantActionsReady && (
            <button type="button" onClick={() => onFork(message)} disabled={actionsDisabled} title="从这里 Fork" aria-label="从这里 Fork">
              {forking ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}
            </button>
          )}
          {assistantActionsReady && <time className="message-action-time">{formatMessageActionTime(message.timestamp)}</time>}
        </div>
      )}
    </article>
  );
});

const MessageListView = memo(function MessageListView({
  messages,
  receivedUserMessages,
  activeTurnMessageId,
  processTerminalState,
  actionsDisabled,
  forkingMessageId,
  onEdit,
  onCopy,
  onFork,
}: {
  messages: RemoteChatMessage[];
  receivedUserMessages: Record<string, RemoteChatMessage | undefined>;
  activeTurnMessageId: string | null | undefined;
  processTerminalState: ProcessTerminalViewState;
  actionsDisabled: boolean;
  forkingMessageId: string | null;
  onEdit: (content: string) => void;
  onCopy: (content: string) => void;
  onFork: (message: RemoteChatMessage) => void;
}) {
  return (
    <>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          receivedUserMessage={receivedUserMessages[message.id]}
          turnRunning={message.id === activeTurnMessageId}
          processTerminalState={processTerminalState}
          actionsDisabled={actionsDisabled}
          forking={forkingMessageId === message.id}
          onEdit={onEdit}
          onCopy={onCopy}
          onFork={onFork}
        />
      ))}
    </>
  );
});

function Questionnaire({
  interaction,
  disabled,
  onSubmit,
}: {
  interaction: RemoteInteraction;
  disabled: boolean;
  onSubmit: (answers: unknown[], text: string, cancelled?: boolean) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const clampPanelHeight = useCallback((height: number) => {
    const root = rootRef.current;
    if (!root) return height;
    const rect = root.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const maxByMessages = Math.max(112, rect.bottom - 112);
    const minHeight = Math.min(160, maxByMessages);
    const maxHeight = Math.max(minHeight, Math.min(viewportHeight * 0.68, maxByMessages));
    return Math.min(Math.max(height, minHeight), maxHeight);
  }, []);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const applyHeight = (clientY: number) => {
      const root = rootRef.current;
      if (!root) return;
      setPanelHeight(clampPanelHeight(root.getBoundingClientRect().bottom - clientY));
    };
    const handleMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      applyHeight(moveEvent.clientY);
    };
    const stopResize = () => {
      document.body.classList.remove("mobile-questionnaire-resizing");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      resizeCleanupRef.current = null;
    };
    document.body.classList.add("mobile-questionnaire-resizing");
    resizeCleanupRef.current = stopResize;
    applyHeight(event.clientY);
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [clampPanelHeight]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const delta = event.key === "ArrowUp" ? 24 : -24;
    setPanelHeight(clampPanelHeight(root.getBoundingClientRect().height + delta));
  }, [clampPanelHeight]);

  const buildAnswers = () => buildQuestionnaireAnswers(interaction.questions, answers, custom);
  const summary = () => getQuestionnaireSummary(interaction.questions, answers, custom);
  const complete = isQuestionnaireComplete(interaction.questions, answers, custom);

  return (
    <section
      ref={rootRef}
      className={`questionnaire ${panelHeight !== null ? "resized" : ""}`}
      style={panelHeight !== null ? { height: panelHeight } : undefined}
    >
      <div
        className="questionnaire-resizer"
        role="separator"
        tabIndex={0}
        aria-label="调整问卷面板高度"
        aria-orientation="horizontal"
        title="拖动调整问卷高度"
        onPointerDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="questionnaire-scroll">
        <div className="questionnaire-header"><MessageSquare size={16} /><strong>需要你的选择</strong></div>
        {interaction.questions.map((question, index) => (
          <div className="questionnaire-question" key={`${question.question}-${index}`}>
            {question.header && <span>{question.header}</span>}
            <p>{question.question}</p>
            <div className="question-options">
              {question.options?.map((option) => {
                const selected = (answers[index] || []).includes(option.label);
                return (
                  <button
                    type="button"
                    className={selected ? "selected" : ""}
                    key={option.label}
                    onClick={() => {
                      setCustom((current) => ({ ...current, [index]: "" }));
                      setAnswers((current) => {
                        const previous = current[index] || [];
                        const isSelected = previous.includes(option.label);
                        return {
                          ...current,
                          [index]: question.multiSelect
                            ? isSelected ? previous.filter((item) => item !== option.label) : [...previous, option.label]
                            : [option.label],
                        };
                      });
                    }}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                );
              })}
            </div>
            <textarea
              value={custom[index] || ""}
              onFocus={() => setAnswers((current) => (
                current[index]?.length ? { ...current, [index]: [] } : current
              ))}
              onChange={(event) => {
                const value = event.target.value;
                setCustom((current) => ({ ...current, [index]: value }));
                if (value.trim()) setAnswers((current) => ({ ...current, [index]: [] }));
              }}
              placeholder="自定义回答"
              rows={2}
            />
          </div>
        ))}
        <div className="questionnaire-actions">
          <button type="button" className="secondary" disabled={disabled} onClick={() => onSubmit([], "", true)}>取消</button>
          <button type="button" disabled={disabled || !complete} onClick={() => onSubmit(buildAnswers(), summary())}>提交</button>
        </div>
      </div>
    </section>
  );
}

function AndroidUpdateDialog({
  open,
  currentVersion,
  metadata,
  stage,
  progress,
  error,
  onClose,
  onPrimary,
}: {
  open: boolean;
  currentVersion: string;
  metadata: AndroidUpdateMetadata | null;
  stage: AndroidUpdateStage;
  progress: number;
  error: string;
  onClose: () => void;
  onPrimary: () => void;
}) {
  if (!open) return null;
  const busy = stage === "checking" || stage === "downloading";
  const title = stage === "up-to-date"
    ? "已是最新版本"
    : stage === "error" && !metadata
      ? "检查更新失败"
      : metadata
        ? `发现 Hpp ${metadata.version}`
        : "检查 Android 更新";
  const primaryLabel = stage === "checking"
    ? "正在检查"
    : stage === "downloading"
      ? progress >= 0 ? `下载中 ${progress}%` : "正在下载"
      : stage === "downloaded"
        ? "安装更新"
        : stage === "permission"
          ? "允许安装更新"
          : stage === "installing"
            ? "重新打开安装器"
            : stage === "up-to-date"
              ? "重新检查"
              : stage === "error" && !metadata
                ? "重试"
                : stage === "error"
                  ? "重新下载"
                  : "下载并安装";

  return (
    <div
      className="sheet-backdrop android-update-backdrop"
      role="presentation"
      onClick={() => { if (!busy) onClose(); }}
    >
      <section
        className="android-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="android-update-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="android-update-header">
          <span className="android-update-icon"><Smartphone size={19} /></span>
          <div>
            <h2 id="android-update-title">{title}</h2>
            <p>当前版本 v{currentVersion}</p>
          </div>
          <button type="button" className="icon-button" disabled={busy} onClick={onClose} title="关闭"><X size={18} /></button>
        </header>
        <div className="android-update-body">
          {metadata && stage !== "up-to-date" && (
            <div className="android-update-version">
              <span>可用版本</span>
              <strong>v{metadata.version}</strong>
            </div>
          )}
          {stage === "checking" && <p className="android-update-status"><LoaderCircle className="spin" size={16} />正在获取最新版本信息</p>}
          {stage === "downloading" && (
            <div className="android-update-progress">
              <div><span>正在下载安装包</span><strong>{progress >= 0 ? `${progress}%` : "下载中"}</strong></div>
              <span className={progress < 0 ? "indeterminate" : ""}>
                <i style={progress >= 0 ? { width: `${progress}%` } : undefined} />
              </span>
            </div>
          )}
          {stage === "permission" && (
            <p className="android-update-notice">Android 需要先允许 Hpp 安装未知应用。授权后返回 Hpp，会自动继续打开系统安装器。</p>
          )}
          {stage === "downloaded" && (
            <p className="android-update-notice">安装包已下载完成，可以继续安装。</p>
          )}
          {stage === "installing" && (
            <p className="android-update-notice">系统安装界面已打开，请确认安装。若没有显示，可以重新打开安装器。</p>
          )}
          {stage === "up-to-date" && <p className="android-update-notice">当前安装的 Hpp 已经是最新版本。</p>}
          {error && <p className="android-update-error" role="alert">{error}</p>}
        </div>
        <footer className="android-update-actions">
          <button type="button" className="secondary-command" disabled={busy} onClick={onClose}>稍后</button>
          <button type="button" className="primary-command" disabled={busy} onClick={onPrimary}>
            {busy && <LoaderCircle className="spin" size={16} />}{primaryLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function Confirmation({
  interaction,
  disabled,
  onRespond,
}: {
  interaction: RemoteInteraction;
  disabled: boolean;
  onRespond: (confirmed: boolean) => void;
}) {
  return (
    <section className="confirmation" role="alertdialog" aria-modal="false">
      <div className="confirmation-heading">
        <ShieldAlert size={17} />
        <strong>{interaction.title || "Agent 请求权限"}</strong>
      </div>
      {interaction.description && <pre>{interaction.description}</pre>}
      <div className="confirmation-actions">
        <button type="button" className="secondary" disabled={disabled} onClick={() => onRespond(false)}>拒绝</button>
        <button type="button" disabled={disabled} onClick={() => onRespond(true)}>允许</button>
      </div>
    </section>
  );
}

function PermissionChoice({
  interaction,
  disabled,
  onRespond,
}: {
  interaction: RemoteInteraction;
  disabled: boolean;
  onRespond: (answers: unknown[], value: string) => void;
}) {
  const question = interaction.questions[0];
  return (
    <section className="confirmation" role="alertdialog" aria-modal="false">
      <div className="confirmation-heading">
        <ShieldAlert size={17} />
        <strong>{interaction.title || "Agent 请求权限"}</strong>
      </div>
      {(interaction.description || question?.question) && <pre>{interaction.description || question?.question}</pre>}
      <div className="confirmation-actions">
        {(question?.options || []).map((option) => {
          const value = String(option.value || option.label);
          const rejecting = ["reject", "deny", "cancel"].includes(value.toLowerCase());
          const answers = [{
            id: question.id,
            questionIndex: 0,
            selected: [option.label],
            selectedOptions: [{ ...option, value }],
            values: [value],
          }];
          return (
            <button
              type="button"
              className={rejecting ? "secondary" : undefined}
              disabled={disabled}
              key={`${value}:${option.label}`}
              onClick={() => onRespond(answers, value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

type QueueEditDraft = {
  content: string;
  composerDocument: ComposerDocument;
  images: NonNullable<RemoteQueuedMessage["images"]>;
  sessionReferences: NonNullable<RemoteQueuedMessage["sessionReferences"]>;
  attachments: NonNullable<RemoteQueuedMessage["attachments"]>;
  action: RemoteQueuedMessage["action"];
};

const queueEditDocument = (item: RemoteQueuedMessage): ComposerDocument => withoutComposerImages(hydrateRemoteComposerDocument(
  item.composerDocument,
  item.images,
) || createComposerDocument([
  ...((item.editableContent ?? item.displayContent) ? [{ id: createClientId(), type: "text" as const, text: item.editableContent ?? item.displayContent }] : []),
  ...(item.attachments || []).map((attachment) => ({ id: createClientId(), type: "text" as const, text: `[${attachment.kind}: ${attachment.name}]` })),
  ...(item.sessionReferences || []).map((reference) => ({ id: createClientId(), type: "session" as const, reference })),
 ]));

const queueEditDraftWithDocument = (draft: QueueEditDraft, document: ComposerDocument): QueueEditDraft => {
  const images = [...draft.images];
  for (const image of getComposerImageNodes(document)) {
    if (!images.some((current) => current.id === image.id)) images.push(image);
  }
  const orderedDocument = withoutComposerImages(document);
  return ({
  ...draft,
  composerDocument: orderedDocument,
  content: getComposerPlainText(orderedDocument),
  images,
  sessionReferences: document.nodes.flatMap((node) => node.type === "session" ? [{
    sourceSessionId: node.reference.sourceSessionId,
    sourceTitle: node.reference.sourceTitle,
  }] : []),
  attachments: document.nodes.flatMap((node): NonNullable<RemoteQueuedMessage["attachments"]> => {
    if (node.type === "path") return [{ id: node.id, name: node.name, kind: node.kind }];
    if (node.type === "snippet") return [{ id: node.id, name: `${node.fileName}:${node.startLine}-${node.endLine}`, kind: "snippet" as const }];
    return [];
  }),
  });
};

type QueueEditDialogProps = {
  item: RemoteQueuedMessage;
  referenceCandidates: RemoteSession[];
  onClose: () => void;
  onSave: (draft: QueueEditDraft) => Promise<void>;
};

function QueueEditDialog({ item, referenceCandidates, onClose, onSave }: QueueEditDialogProps) {
  const [draft, setDraft] = useState<QueueEditDraft>(() => ({
    content: item.editableContent ?? item.displayContent,
    composerDocument: queueEditDocument(item),
    images: item.images || [],
    sessionReferences: item.sessionReferences || [],
    attachments: item.attachments || [],
    action: item.action,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<InlineComposerEditorHandle | null>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setAddMenuOpen(false);
      setReferencePickerOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [addMenuOpen]);

  useLayoutEffect(() => {
    if (!addMenuOpen) {
      setAddMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchor = addMenuRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = referencePickerOpen ? Math.min(390, window.innerWidth - 28) : 160;
      const estimatedHeight = referencePickerOpen ? 260 : 92;
      const opensUpward = anchor.top >= estimatedHeight + 14;
      setAddMenuPosition({
        left: Math.max(14, Math.min(anchor.left, window.innerWidth - width - 14)),
        width,
        ...(opensUpward
          ? { bottom: Math.max(14, window.innerHeight - anchor.top + 7) }
          : { top: Math.max(14, Math.min(window.innerHeight - estimatedHeight - 14, anchor.bottom + 7)) }),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [addMenuOpen, referencePickerOpen]);

  const addImage = useCallback(async () => {
    setAddMenuOpen(false);
    setReferencePickerOpen(false);
    if (draft.images.length >= MAX_REMOTE_IMAGES) {
      setError(`最多添加 ${MAX_REMOTE_IMAGES} 张图片`);
      return;
    }
    try {
      const image = await chooseRemoteImage();
      setDraft((current) => ({
        ...current,
        images: [...current.images, { id: image.id, name: image.name, mimeType: image.mimeType, src: image.preview }],
      }));
      setError("");
    } catch (imageError) {
      if (!isImageSelectionCancelled(imageError)) setError(getImageErrorMessage(imageError));
    }
  }, [draft.images.length]);

  const toggleReference = useCallback((session: RemoteSession) => {
    const exists = draft.sessionReferences.some((reference) => reference.sourceSessionId === session.id);
    if (exists) {
      const document = createComposerDocument(draft.composerDocument.nodes.filter((node) =>
        node.type !== "session" || node.reference.sourceSessionId !== session.id
      ));
      setDraft((current) => queueEditDraftWithDocument(current, document));
      return;
    }
    if (draft.sessionReferences.length >= MAX_REMOTE_SESSION_REFERENCES) return;
    editorRef.current?.insertNode({ id: createClientId(), type: "session", reference: { sourceSessionId: session.id, sourceTitle: session.title } });
  }, [draft]);

  const hasContent = !!draft.content.trim() || draft.images.length > 0 || draft.sessionReferences.length > 0
    || draft.attachments.length > 0 || !!draft.action;
  const submit = useCallback(async () => {
    if (!hasContent || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [draft, hasContent, onClose, onSave, saving]);

  return (
    <div className="sheet-backdrop queue-edit-backdrop" onPointerDown={onClose}>
      <section
        className="queue-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-edit-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-title queue-edit-title">
          <div><h2 id="queue-edit-title">编辑队列消息</h2><p>保存后会按当前附件重新生成发送内容</p></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving} title="关闭"><X size={18} /></button>
        </header>
        <div className="queue-edit-body">
          {draft.action && (
            <div className="queue-edit-contexts">
              {draft.action && (
                <div className="queue-edit-chip action">
                  <Bot size={13} />
                  <span>{draft.action.kind === "skill" ? "技能" : "命令"} · {draft.action.name}</span>
                  <button type="button" onClick={() => setDraft((current) => ({ ...current, action: undefined }))} title="移除"><X size={12} /></button>
                </div>
              )}
            </div>
          )}
          {draft.images.length > 0 && (
            <div className="queue-edit-contexts">
              {draft.images.map((image) => (
                <div className="queue-edit-chip" key={image.id}>
                  <img src={image.src} alt={image.name} />
                  <span>Image</span>
                  <button type="button" onClick={() => setDraft((current) => ({ ...current, images: current.images.filter((item) => item.id !== image.id) }))} title="移除图片"><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="queue-edit-composer">
            <InlineComposerEditor
              ref={editorRef}
              value={draft.composerDocument}
              onChange={(document) => setDraft((current) => queueEditDraftWithDocument(current, document))}
              placeholder={draft.action ? "添加技能参数或说明" : "编辑消息内容"}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Escape") onClose();
                if (event.key === "Enter" && event.ctrlKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          {error && <div className="queue-edit-error" role="alert">{error}</div>}
        </div>
        <footer className="queue-edit-actions">
          <div className="queue-edit-add-control" ref={addMenuRef}>
            <button
              type="button"
              className={`queue-edit-add-button${addMenuOpen ? " active" : ""}`}
              aria-label="添加图片或引用"
              aria-expanded={addMenuOpen}
              title="添加图片或引用"
              onClick={() => {
                setAddMenuOpen((open) => {
                  if (open) setReferencePickerOpen(false);
                  return !open;
                });
              }}
            >
              <Plus size={16} />
            </button>
            {addMenuOpen && addMenuPosition && createPortal(
              <>
                <div
                  className="queue-edit-add-backdrop"
                  aria-hidden="true"
                  onPointerDown={() => {
                    setAddMenuOpen(false);
                    setReferencePickerOpen(false);
                  }}
                />
                <div
                  className={`queue-edit-add-menu${referencePickerOpen ? " references" : ""}`}
                  role="menu"
                  style={addMenuPosition}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {referencePickerOpen ? (
                    <>
                      <div className="queue-edit-add-menu-header">
                        <button type="button" onClick={() => setReferencePickerOpen(false)} title="返回"><ArrowLeft size={15} /></button>
                        <span>引用会话</span>
                        <small>{draft.sessionReferences.length > 0 ? `已选 ${draft.sessionReferences.length}` : ""}</small>
                      </div>
                      <div className="queue-edit-reference-list">
                        {referenceCandidates.length === 0 ? (
                          <div className="queue-edit-reference-empty">暂无可引用的会话</div>
                        ) : referenceCandidates.map((candidate) => {
                          const checked = draft.sessionReferences.some((reference) => reference.sourceSessionId === candidate.id);
                          return (
                            <button type="button" className={checked ? "selected" : ""} key={candidate.id} onClick={() => toggleReference(candidate)}>
                              <Link2 size={14} />
                              <span>{candidate.title}</span>
                              {checked && <Check size={14} />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <>
                      <button type="button" role="menuitem" disabled={draft.images.length >= MAX_REMOTE_IMAGES} onClick={() => void addImage()}><Camera size={15} /><span>图片</span></button>
                      <button type="button" role="menuitem" disabled={referenceCandidates.length === 0} onClick={() => setReferencePickerOpen(true)}><Link2 size={15} /><span>引用会话</span></button>
                    </>
                  )}
                </div>
              </>,
              document.body,
            )}
          </div>
          <div className="queue-edit-action-buttons">
            <button type="button" className="secondary-command" onClick={onClose} disabled={saving}>取消</button>
            <button type="button" className="primary-command" onClick={() => void submit()} disabled={!hasContent || saving}>{saving ? "保存中..." : "保存修改"}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

type QueuePanelProps = {
  items: RemoteQueuedMessage[];
  disabled: boolean;
  canGuide: boolean;
  currentSessionRunning: boolean;
  onEdit: (item: RemoteQueuedMessage) => void;
  onGuide: (item: RemoteQueuedMessage) => void;
  onReorder: (itemId: string, toIndex: number) => void;
  onRemove: (item: RemoteQueuedMessage) => void;
};

function QueuePanel({ items, disabled, canGuide, currentSessionRunning, onEdit, onGuide, onReorder, onRemove }: QueuePanelProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("before");
  const draggingIdRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const queueScrollRef = useRef<HTMLDivElement | null>(null);
  const { update: updateQueueAutoScroll, stop: stopQueueAutoScroll } = useDragAutoScroll(queueScrollRef);

  const finishDragging = () => {
    stopQueueAutoScroll();
    draggingIdRef.current = null;
    dropIndexRef.current = null;
    setDraggingId(null);
    setDropTargetIndex(null);
    setDropPosition("before");
  };
  const startDragging = (event: ReactPointerEvent<HTMLButtonElement>, item: RemoteQueuedMessage) => {
    if (disabled || item.status === "sending") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingIdRef.current = item.id;
    dropIndexRef.current = null;
    setDraggingId(item.id);
    setDropTargetIndex(null);
    setDropPosition("before");
  };
  const moveDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingIdRef.current) return;
    event.preventDefault();
    updateQueueAutoScroll(event.clientY);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-id]");
    if (!target) return;
    const index = items.findIndex((item) => item.id === target.dataset.queueId);
    const sourceIndex = items.findIndex((item) => item.id === draggingIdRef.current);
    if (index < 0 || sourceIndex < 0) return;
    const rect = target.getBoundingClientRect();
    const insertAfter = event.clientY >= rect.top + rect.height / 2;
    const rawInsertIndex = index + (insertAfter ? 1 : 0);
    const nextIndex = sourceIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex;
    if (nextIndex === sourceIndex) {
      dropIndexRef.current = null;
      setDropTargetIndex(null);
      return;
    }
    dropIndexRef.current = nextIndex;
    setDropTargetIndex(index);
    setDropPosition(insertAfter ? "after" : "before");
  };
  const stopDragging = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const itemId = draggingIdRef.current;
    const targetIndex = dropIndexRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    finishDragging();
    if (commit && itemId && targetIndex !== null) onReorder(itemId, targetIndex);
  };

  return (
    <div className="queue-strip">
      <div className="queue-header"><span>发送队列</span><small>{items.length}</small></div>
      <div ref={queueScrollRef} className="queue-list">
        {items.map((item, index) => (
          <div
            className={`queue-item ${item.status} ${draggingId === item.id ? "dragging" : ""} ${dropTargetIndex === index && draggingId !== item.id ? `drop-target ${dropPosition}` : ""}`}
            data-queue-id={item.id}
            key={item.id}
          >
            <button
              type="button"
              className="queue-drag"
              disabled={disabled || item.status === "sending"}
              title="拖动调整顺序"
              aria-label={`拖动第 ${index + 1} 条队列消息`}
              onPointerDown={(event) => startDragging(event, item)}
              onPointerMove={moveDragging}
              onPointerUp={(event) => stopDragging(event, true)}
              onPointerCancel={(event) => stopDragging(event, false)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                onReorder(item.id, index + (event.key === "ArrowUp" ? -1 : 1));
              }}
            >
              <GripVertical size={13} />
              <span>{index + 1}</span>
            </button>
            <div className="queue-main">
              {item.action && <span className="queue-action-badge">{item.action.kind === "skill" ? "技能" : "命令"} · {item.action.name}</span>}
              <span>{item.displayContent
                ? renderAttachmentPreview(item.displayContent, 120)
                : (item.sessionReferences?.length ? `引用会话：${item.sessionReferences.map((reference) => reference.sourceTitle).join("、")}` : "空消息")}</span>
              {item.error && <small>{item.error}</small>}
            </div>
            <div className="queue-controls">
              <button type="button" className="queue-icon-button" disabled={disabled || item.status === "sending"} onClick={() => onEdit(item)} title="编辑" aria-label="编辑队列消息"><Pencil size={13} /></button>
              {canGuide && !item.action && (
                <button
                  type="button"
                  className="queue-guide"
                  disabled={disabled || !currentSessionRunning || item.status === "sending"}
                  onClick={() => onGuide(item)}
                  title={currentSessionRunning ? "立即作为引导发送" : "Agent 运行中才能引导"}
                >
                  {item.status === "sending" ? <LoaderCircle className="spin" size={13} /> : <CornerDownRight size={13} />}
                  <span>引导</span>
                </button>
              )}
              <button type="button" className="queue-icon-button queue-remove" disabled={disabled || item.status === "sending"} onClick={() => onRemove(item)} title="移出队列" aria-label="移出队列"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const demoVariant = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("demo") : null;
  const demoMode = demoVariant !== null;
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hostAvailability, setHostAvailability] = useState<Record<string, HostAvailability>>({});
  const [lastHostId, setLastHostId] = useState<string | null>(null);
  const [activeHost, setActiveHost] = useState<PairedHost | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [agents, setAgents] = useState<RemoteAgent[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, RemoteChatMessage[]>>({});
  const [nextBefore, setNextBefore] = useState<Record<string, number | null>>({});
  const [queues, setQueues] = useState<Record<string, RemoteQueuedMessage[]>>({});
  const [editingQueueItem, setEditingQueueItem] = useState<RemoteQueuedMessage | null>(null);
  const [interactions, setInteractions] = useState<Record<string, RemoteInteraction | null>>({});
  const [configs, setConfigs] = useState<Record<string, RemoteSessionConfig>>({});
  const [loadingSession, setLoadingSession] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [composer, setComposer] = useState("");
  const [composerDocument, setComposerDocument] = useState<ComposerDocument>(() => createComposerDocument());
  const [composerComposition, setComposerComposition] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingRemoteImage[]>([]);
  const [pendingReferenceIds, setPendingReferenceIds] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<RemoteAgentActionInvocation | undefined>();
  const [composerAddMenuOpen, setComposerAddMenuOpen] = useState(false);
  const [referenceSheetOpen, setReferenceSheetOpen] = useState(false);
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [actionCatalog, setActionCatalog] = useState<RemoteAgentAction[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pairingMode, setPairingMode] = useState<PairingMode>("closed");
  const [pairingLink, setPairingLink] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingHostAlias, setEditingHostAlias] = useState("");
  const [editingHostNote, setEditingHostNote] = useState("");
  const [editingAddress, setEditingAddress] = useState("");
  const [savingHostId, setSavingHostId] = useState<string | null>(null);
  const [hostPullDistance, setHostPullDistance] = useState(0);
  const [refreshingHosts, setRefreshingHosts] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyProjectId, setHistoryProjectId] = useState<string | null>(null);
  const [createProject, setCreateProject] = useState<RemoteProject | null>(null);
  const [createAgentId, setCreateAgentId] = useState("");
  const [createSessionId, setCreateSessionId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [reloadingSession, setReloadingSession] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [showReturnToBottom, setShowReturnToBottom] = useState(false);
  const [error, setError] = useState("");
  const [floatingToast, setFloatingToast] = useState<{ id: number; text: string } | null>(null);
  const [appVersion, setAppVersion] = useState(mobilePackage.version);
  const [updateMetadata, setUpdateMetadata] = useState<AndroidUpdateMetadata | null>(null);
  const [updateStage, setUpdateStage] = useState<AndroidUpdateStage>("idle");
  const [updateProgress, setUpdateProgress] = useState(-1);
  const [updateError, setUpdateError] = useState("");
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const clientRef = useRef<RemoteClient | null>(null);
  const activeHostRef = useRef<PairedHost | null>(null);
  const hostsRef = useRef<PairedHost[]>([]);
  const selectedSessionRef = useRef<string | null>(null);
  const projectsRef = useRef<RemoteProject[]>([]);
  const agentsRef = useRef<RemoteAgent[]>([]);
  const configsRef = useRef<Record<string, RemoteSessionConfig>>({});
  const revisionsRef = useRef<Record<string, number>>({});
  const requiredSessionRevisionsRef = useRef<Record<string, number>>({});
  const unrevisionedSessionEventVersionsRef = useRef<Record<string, number>>({});
  const sessionLoadGenerationsRef = useRef<Record<string, number>>({});
  const staleSessionIdsRef = useRef(new Set<string>());
  const loadingSessionIdsRef = useRef(new Set<string>());
  const reloadAfterSessionLoadRef = useRef(new Set<string>());
  const loadSessionRef = useRef<(sessionId: string, replace?: boolean, before?: number | null) => Promise<void>>(
    async () => undefined,
  );
  const hostEpochRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineComposerRef = useRef<InlineComposerEditorHandle | null>(null);
  const composerAddMenuRef = useRef<HTMLDivElement | null>(null);
  const messagesViewRef = useRef<HTMLDivElement | null>(null);
  const followMessageBottomRef = useRef(true);
  const returningToBottomRef = useRef(false);
  const forkSessionIdsRef = useRef(new Map<string, string>());
  const floatingToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftIdentityRef = useRef<{ hostId: string; sessionId: string; key: string } | null>(null);
  const loadedDraftKeyRef = useRef<string | null>(null);
  /** 用户是否已在草稿加载完成前主动输入（用于避免加载结果覆盖正在输入的内容，并确保输入内容能被保存）。 */
  const draftUserEditedRef = useRef(false);
  const draftValueRef = useRef<ComposerDraftValue>({ text: "", referenceSessionIds: [] });
  const autoConnectAttemptedRef = useRef(false);
  const updateMetadataRef = useRef<AndroidUpdateMetadata | null>(null);
  const updateCheckInFlightRef = useRef(false);
  const connectionsScreenRef = useRef<HTMLElement | null>(null);
  const editingHostFormRef = useRef<HTMLFormElement | null>(null);
  const editingHostTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hostPullStartRef = useRef<number | null>(null);
  const hostPullDistanceRef = useRef(0);
  const dismissedUpdateVersionRef = useRef<number | null>(null);
  const updateStageRef = useRef<AndroidUpdateStage>("idle");
  const updateInstallInFlightRef = useRef(false);
  const incomingWebPairingRef = useRef(
    !IS_NATIVE_APP ? new URLSearchParams(window.location.search).get("pair") : null,
  );

  selectedSessionRef.current = selectedSessionId;
  activeHostRef.current = activeHost;
  hostsRef.current = hosts;
  projectsRef.current = projects;
  agentsRef.current = agents;
  configsRef.current = configs;
  updateStageRef.current = updateStage;
  draftValueRef.current = { text: composer, document: composerDocument, referenceSessionIds: pendingReferenceIds, action: pendingAction };

  const flushCurrentDraft = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    const identity = draftIdentityRef.current;
    if (!identity) return;
    // 草稿尚未加载完成时，仅当用户已经主动输入过才保存，避免空草稿覆盖已存内容。
    if (loadedDraftKeyRef.current !== identity.key && !draftUserEditedRef.current) return;
    void saveSessionDraft(identity.hostId, identity.sessionId, draftValueRef.current)
      .catch((error) => console.error("[mobile-draft] save failed", error));
  }, []);

  useEffect(() => {
    if (demoVariant) {
      if (demoVariant === "hosts" || demoVariant === "update") {
        setHostsLoaded(true);
        setHosts([DEMO_HOST]);
        setHostAvailability({ [DEMO_HOST.id]: "online" });
        if (demoVariant === "update") {
          const previewMetadata: AndroidUpdateMetadata = {
            version: "0.1.4",
            versionCode: 104,
            url: "https://github.com/xhaoh94/Hpp/releases/latest/download/Hpp-Android.apk",
            sha256: "a".repeat(64),
            publishedAt: new Date().toISOString(),
          };
          updateMetadataRef.current = previewMetadata;
          setUpdateMetadata(previewMetadata);
          setUpdateStage("available");
          setUpdateDialogOpen(true);
        }
        return;
      }
      setHostsLoaded(true);
      setActiveHost(DEMO_HOST);
      setConnectionState("connected");
      setProjects(DEMO_PROJECTS);
      setAgents(DEMO_AGENTS);
      setSelectedSessionId(demoVariant === "empty" ? null : DEMO_SESSION_ID);
      setMessages({
        [DEMO_SESSION_ID]: DEMO_MESSAGES,
        "demo-session-2": [],
        "demo-session-3": [
          {
            id: "demo-history-user",
            role: "user",
            content: "检查上一版发布任务的构建结果。",
            timestamp: Date.now() - 86_460_000,
          },
          {
            id: "demo-history-assistant",
            role: "assistant",
            content: "构建已完成，桌面端与移动端产物均通过检查。",
            timestamp: Date.now() - 86_400_000,
          },
        ],
      });
      setNextBefore({ [DEMO_SESSION_ID]: null });
      setQueues({
        [DEMO_SESSION_ID]: [{
          id: "demo-queued",
          sessionId: DEMO_SESSION_ID,
          displayContent: "完成后再检查一次小屏设备",
          status: "queued",
          createdAt: Date.now(),
        }, {
          id: "demo-queued-2",
          sessionId: DEMO_SESSION_ID,
          displayContent: "再确认一次横屏布局中的队列操作",
          status: "queued",
          createdAt: Date.now() + 1,
        }],
      });
      setConfigs({
        [DEMO_SESSION_ID]: DEMO_CONFIG,
        "demo-session-2": DEMO_CONFIG,
        "demo-session-3": DEMO_CONFIG,
      });
      if (demoVariant === "question") {
        setInteractions({
          [DEMO_SESSION_ID]: {
            sessionId: DEMO_SESSION_ID,
            requestId: "demo-question",
            questions: [{
              question: "输入区采用哪种默认高度？",
              options: [
                { label: "紧凑", value: "compact", description: "默认一行，按内容增高" },
                { label: "宽松", value: "comfortable", description: "默认两行" },
              ],
            }],
          },
        });
      } else if (demoVariant === "create") {
        setDrawerOpen(true);
        setCreateProject(DEMO_PROJECTS[0]);
        setCreateAgentId(DEMO_AGENTS[0].id);
        setCreateSessionId(createClientId());
      }
      return;
    }
    void Promise.all([loadPairedHosts(), loadLastPairedHostId()]).then(([saved, savedLastHostId]) => {
      setHosts(saved);
      setLastHostId(savedLastHostId);
      setHostsLoaded(true);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setHostsLoaded(true);
    });
  }, [demoVariant]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(112, Math.max(36, textarea.scrollHeight))}px`;
  }, [composer]);

  const showFloatingToast = useCallback((text: string) => {
    if (floatingToastTimerRef.current) clearTimeout(floatingToastTimerRef.current);
    setFloatingToast({ id: Date.now(), text });
    floatingToastTimerRef.current = setTimeout(() => {
      setFloatingToast(null);
      floatingToastTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => () => {
    if (floatingToastTimerRef.current) clearTimeout(floatingToastTimerRef.current);
  }, []);

  const applyAndroidDownloadStatus = useCallback((status: AndroidUpdaterDownloadStatus, openDialog = true) => {
    if (status.status === "downloading") {
      setUpdateProgress(status.progress);
      setUpdateError("");
      setUpdateStage("downloading");
      if (openDialog) setUpdateDialogOpen(true);
      return true;
    }
    if (status.status === "downloaded") {
      setUpdateProgress(100);
      setUpdateError("");
      setUpdateStage("downloaded");
      if (openDialog) setUpdateDialogOpen(true);
      return true;
    }
    if (status.status === "failed") {
      setUpdateError(getAndroidUpdateErrorMessage({ code: status.errorCode || "DOWNLOAD_FAILED" }));
      setUpdateStage("error");
      if (openDialog) setUpdateDialogOpen(true);
      return true;
    }
    return false;
  }, []);

  const checkAndroidUpdate = useCallback(async (manual: boolean) => {
    if (!IS_NATIVE_APP) return;
    if (updateCheckInFlightRef.current) {
      if (manual) setUpdateDialogOpen(true);
      return;
    }
    updateCheckInFlightRef.current = true;
    setUpdateStage("checking");
    setUpdateError("");
    if (manual) setUpdateDialogOpen(true);
    try {
      const info = await CapacitorApp.getInfo();
      setAppVersion(info.version || mobilePackage.version);
      const metadata = await fetchAndroidUpdateMetadata();
      if (isAndroidUpdateAvailable(info.build, metadata)) {
        updateMetadataRef.current = metadata;
        setUpdateMetadata(metadata);
        const nativeStatus = await HppUpdater.getUpdateStatus({ sha256: metadata.sha256 });
        if (applyAndroidDownloadStatus(nativeStatus)) return;
        setUpdateStage("available");
        if (manual || dismissedUpdateVersionRef.current !== metadata.versionCode) {
          setUpdateDialogOpen(true);
        }
      } else {
        updateMetadataRef.current = null;
        setUpdateMetadata(null);
        setUpdateStage(manual ? "up-to-date" : "idle");
      }
    } catch (updateFailure) {
      const message = getAndroidUpdateErrorMessage(updateFailure);
      if (manual) {
        updateMetadataRef.current = null;
        setUpdateMetadata(null);
        setUpdateError(message);
        setUpdateStage("error");
        setUpdateDialogOpen(true);
      } else {
        setUpdateStage("idle");
        console.warn("[android-updater] automatic check failed", updateFailure);
      }
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, [applyAndroidDownloadStatus]);

  const continueDownloadedInstall = useCallback(async () => {
    const metadata = updateMetadataRef.current;
    if (!metadata || updateInstallInFlightRef.current) return;
    updateInstallInFlightRef.current = true;
    setUpdateError("");
    setUpdateStage("installing");
    setUpdateDialogOpen(true);
    try {
      const result = await HppUpdater.installDownloaded({ sha256: metadata.sha256 });
      if (result.status === "permission-required") {
        setUpdateStage("permission");
        return;
      }
      dismissedUpdateVersionRef.current = metadata.versionCode;
      setUpdateStage("installing");
    } catch (installFailure) {
      setUpdateError(getAndroidUpdateErrorMessage(installFailure));
      setUpdateStage("error");
    } finally {
      updateInstallInFlightRef.current = false;
    }
  }, []);

  const requestInstallPermission = useCallback(async () => {
    if (!updateMetadataRef.current) return;
    setUpdateError("");
    try {
      const result = await HppUpdater.requestInstallPermission();
      if (result.granted) {
        await continueDownloadedInstall();
      } else {
        setUpdateError("尚未允许 Hpp 安装未知应用，请授权后重试");
        setUpdateStage("permission");
      }
    } catch (permissionFailure) {
      setUpdateError(getAndroidUpdateErrorMessage(permissionFailure));
      setUpdateStage("permission");
    }
  }, [continueDownloadedInstall]);

  const downloadAndroidUpdate = useCallback(async () => {
    const metadata = updateMetadataRef.current;
    if (!metadata) {
      await checkAndroidUpdate(true);
      return;
    }
    setUpdateProgress(0);
    setUpdateError("");
    setUpdateStage("downloading");
    setUpdateDialogOpen(true);
    try {
      const status = await HppUpdater.startDownload({
        url: metadata.url,
        sha256: metadata.sha256,
      });
      if (status.status === "downloaded") await continueDownloadedInstall();
      else applyAndroidDownloadStatus(status);
    } catch (downloadFailure) {
      setUpdateError(getAndroidUpdateErrorMessage(downloadFailure));
      setUpdateStage("error");
    }
  }, [applyAndroidDownloadStatus, checkAndroidUpdate, continueDownloadedInstall]);

  const syncAndroidUpdateDownload = useCallback(async (installWhenDownloaded: boolean) => {
    const metadata = updateMetadataRef.current;
    if (!metadata) return;
    try {
      const status = await HppUpdater.getUpdateStatus({ sha256: metadata.sha256 });
      if (status.status === "downloaded" && installWhenDownloaded) {
        await continueDownloadedInstall();
        return;
      }
      if (!applyAndroidDownloadStatus(status) && updateStageRef.current === "downloading") {
        setUpdateError("安装包下载已中断，请重新下载");
        setUpdateStage("error");
        setUpdateDialogOpen(true);
      }
    } catch (statusFailure) {
      setUpdateError(getAndroidUpdateErrorMessage(statusFailure));
      setUpdateStage("error");
      setUpdateDialogOpen(true);
    }
  }, [applyAndroidDownloadStatus, continueDownloadedInstall]);

  const closeUpdateDialog = useCallback(() => {
    const metadata = updateMetadataRef.current;
    if (metadata) dismissedUpdateVersionRef.current = metadata.versionCode;
    setUpdateDialogOpen(false);
  }, []);

  const handleUpdatePrimary = useCallback(() => {
    if (updateStage === "permission") {
      void requestInstallPermission();
      return;
    }
    if (updateStage === "downloaded" || updateStage === "installing") {
      void continueDownloadedInstall();
      return;
    }
    if (updateStage === "up-to-date" || (updateStage === "error" && !updateMetadataRef.current)) {
      void checkAndroidUpdate(true);
      return;
    }
    void downloadAndroidUpdate();
  }, [checkAndroidUpdate, continueDownloadedInstall, downloadAndroidUpdate, requestInstallPermission, updateStage]);

  useEffect(() => {
    if (demoMode || !IS_NATIVE_APP) return;
    void checkAndroidUpdate(false);
  }, [checkAndroidUpdate, demoMode]);

  useEffect(() => {
    if (!IS_NATIVE_APP || updateStage !== "downloading") return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        await syncAndroidUpdateDownload(true);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 750);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [syncAndroidUpdateDownload, updateStage]);

  const updateHosts = useCallback(async (next: PairedHost[]) => {
    const retainedHostIds = new Set(next.map((host) => host.hostId));
    await Promise.all(hostsRef.current
      .filter((host) => !retainedHostIds.has(host.hostId))
      .map((host) => clearHostSessionDrafts(host.hostId)));
    hostsRef.current = next;
    setHosts(next);
    await savePairedHosts(next);
  }, []);

  const applyCatalog = useCallback((nextProjects: RemoteProject[], nextAgents: RemoteAgent[]) => {
    const validSessionIds = new Set(nextProjects.flatMap((project) => project.sessions.map((session) => session.id)));
    const retainSessions = <T,>(record: Record<string, T>) => Object.fromEntries(
      Object.entries(record).filter(([sessionId]) => validSessionIds.has(sessionId))
    );
    const selectedSessionId = selectedSessionRef.current;
    if (selectedSessionId && !validSessionIds.has(selectedSessionId)) {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      draftIdentityRef.current = null;
      loadedDraftKeyRef.current = null;
      draftUserEditedRef.current = false;
      draftValueRef.current = { text: "", referenceSessionIds: [] };
      selectedSessionRef.current = null;
      setSelectedSessionId(null);
    }
    setPendingReferenceIds((current) => current.filter((sessionId) => validSessionIds.has(sessionId)));
    setMessages((current) => retainSessions(current));
    setNextBefore((current) => retainSessions(current));
    setQueues((current) => retainSessions(current));
    setInteractions((current) => retainSessions(current));
    setConfigs((current) => {
      const next = retainSessions(current);
      configsRef.current = next;
      return next;
    });
    revisionsRef.current = retainSessions(revisionsRef.current);
    requiredSessionRevisionsRef.current = retainSessions(requiredSessionRevisionsRef.current);
    unrevisionedSessionEventVersionsRef.current = retainSessions(unrevisionedSessionEventVersionsRef.current);
    sessionLoadGenerationsRef.current = retainSessions(sessionLoadGenerationsRef.current);
    staleSessionIdsRef.current = new Set([...staleSessionIdsRef.current].filter((sessionId) => validSessionIds.has(sessionId)));
    loadingSessionIdsRef.current = new Set([...loadingSessionIdsRef.current].filter((sessionId) => validSessionIds.has(sessionId)));
    reloadAfterSessionLoadRef.current = new Set([...reloadAfterSessionLoadRef.current].filter((sessionId) => validSessionIds.has(sessionId)));
    projectsRef.current = nextProjects;
    agentsRef.current = nextAgents;
    setProjects(nextProjects);
    setAgents(nextAgents);
    const hostId = activeHostRef.current?.hostId;
    if (hostId) {
      void pruneSessionDrafts(hostId, validSessionIds)
        .catch((error) => console.error("[mobile-draft] cleanup failed", error));
    }
  }, []);

  const loadCatalog = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    const snapshot = await client.request<RemoteCatalogSnapshot>("catalog.get");
    hostEpochRef.current = snapshot.hostEpoch;
    applyCatalog(snapshot.projects, snapshot.agents || []);
  }, [applyCatalog]);

  const applySessionConfig = useCallback((sessionId: string, config: RemoteSessionConfig) => {
    setConfigs((current) => {
      const previous = current[sessionId];
      const sameModel = previous?.model?.id === config.model?.id && previous?.model?.provider === config.model?.provider;
      const sameAvailableModels = previous?.availableModels === config.availableModels || (
        previous?.availableModels && config.availableModels &&
        previous.availableModels.length === config.availableModels.length &&
        previous.availableModels.every((model, index) => {
          const next = config.availableModels![index];
          return model.id === next.id && model.provider === next.provider;
        })
      );
      if (
        previous &&
        sameModel &&
        previous.thinkingLevel === config.thinkingLevel &&
        previous.planModeEnabled === config.planModeEnabled &&
        previous.permissionMode === config.permissionMode &&
        sameAvailableModels
      ) return current;
      const next = { ...current, [sessionId]: config };
      configsRef.current = next;
      return next;
    });
  }, []);

  const loadSession = useCallback(async (sessionId: string, replace = true, before?: number | null) => {
    const client = clientRef.current;
    if (!client) return;
    if (replace && loadingSessionIdsRef.current.has(sessionId)) {
      if (staleSessionIdsRef.current.has(sessionId)) reloadAfterSessionLoadRef.current.add(sessionId);
      return;
    }
    const loadGeneration = replace
      ? (sessionLoadGenerationsRef.current[sessionId] || 0) + 1
      : 0;
    const requestUnrevisionedEventVersion = unrevisionedSessionEventVersionsRef.current[sessionId] || 0;
    if (replace) {
      sessionLoadGenerationsRef.current[sessionId] = loadGeneration;
      loadingSessionIdsRef.current.add(sessionId);
      reloadAfterSessionLoadRef.current.delete(sessionId);
    }
    setLoadingSession(true);
    try {
      const page = await client.request<SessionPage>("session.get", {
        sessionId,
        ...(before !== undefined && before !== null ? { before } : {}),
        limit: 50,
      });
      if (clientRef.current !== client) return;
      if (replace && sessionLoadGenerationsRef.current[sessionId] !== loadGeneration) return;
      const requiredRevision = Math.max(
        revisionsRef.current[sessionId] || 0,
        requiredSessionRevisionsRef.current[sessionId] || 0,
      );
      const responseCurrent = isSessionPageResponseCurrent(
        page.revision,
        requiredRevision,
        requestUnrevisionedEventVersion,
        unrevisionedSessionEventVersionsRef.current[sessionId] || 0,
      );
      if (replace && (!responseCurrent || reloadAfterSessionLoadRef.current.has(sessionId))) {
        staleSessionIdsRef.current.add(sessionId);
        reloadAfterSessionLoadRef.current.add(sessionId);
        return;
      }
      revisionsRef.current[sessionId] = Math.max(revisionsRef.current[sessionId] || 0, page.revision);
      if (replace) {
        staleSessionIdsRef.current.delete(sessionId);
        reloadAfterSessionLoadRef.current.delete(sessionId);
      }
      setMessages((current) => ({
        ...current,
        [sessionId]: replace ? page.messages : [...page.messages, ...(current[sessionId] || [])],
      }));
      setNextBefore((current) => ({ ...current, [sessionId]: page.nextBefore }));
      setQueues((current) => ({ ...current, [sessionId]: page.queue || [] }));
      setInteractions((current) => ({ ...current, [sessionId]: page.interaction || null }));
      if (page.config) applySessionConfig(sessionId, page.config);
      if (replace) {
        void client.request<RemoteSessionConfig>("session.models.get", { sessionId }).then((config) => {
          applySessionConfig(sessionId, config);
        }).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      let reload = false;
      if (
        replace &&
        clientRef.current === client &&
        sessionLoadGenerationsRef.current[sessionId] === loadGeneration
      ) {
        loadingSessionIdsRef.current.delete(sessionId);
        reload = reloadAfterSessionLoadRef.current.delete(sessionId);
      }
      setLoadingSession(false);
      if (
        reload &&
        clientRef.current === client &&
        projectsRef.current.some((project) => project.sessions.some((session) => session.id === sessionId))
      ) {
        queueMicrotask(() => void loadSessionRef.current(sessionId));
      }
    }
  }, [applySessionConfig]);
  loadSessionRef.current = loadSession;

  const copyMessage = useCallback((content: string) => {
    void copyText(content).then(() => {
      showFloatingToast("已复制");
    }).catch(() => {
      showFloatingToast("复制失败");
    });
  }, [showFloatingToast]);

  const handleRemoteEvent = useCallback((name: string, payload: unknown, revision?: number, hostEpoch?: string) => {
    if (hostEpochRef.current && hostEpoch && hostEpochRef.current !== hostEpoch) {
      hostEpochRef.current = hostEpoch;
      for (const sessionId of loadingSessionIdsRef.current) {
        reloadAfterSessionLoadRef.current.add(sessionId);
      }
      staleSessionIdsRef.current = new Set([
        ...Object.keys(configsRef.current),
        ...Object.keys(revisionsRef.current),
      ]);
      revisionsRef.current = {};
      requiredSessionRevisionsRef.current = {};
      setMessages({});
      setQueues({});
      setInteractions({});
      setConfigs({});
      const selectedSessionId = selectedSessionRef.current;
      void loadCatalog().then(() => {
        if (selectedSessionId) void loadSession(selectedSessionId);
      });
      return;
    }
    const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (name === "catalog.updated") {
      if (Array.isArray(data.projects)) {
        applyCatalog(
          data.projects as RemoteProject[],
          Array.isArray(data.agents) ? data.agents as RemoteAgent[] : agentsRef.current,
        );
      } else if (Array.isArray(data.agents)) {
        agentsRef.current = data.agents as RemoteAgent[];
        setAgents(data.agents as RemoteAgent[]);
      }
      return;
    }
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
    if (!sessionId) return;
    if (revision) {
      requiredSessionRevisionsRef.current[sessionId] = Math.max(
        requiredSessionRevisionsRef.current[sessionId] || 0,
        revision,
      );
    } else {
      unrevisionedSessionEventVersionsRef.current[sessionId] =
        (unrevisionedSessionEventVersionsRef.current[sessionId] || 0) + 1;
    }
    if (staleSessionIdsRef.current.has(sessionId)) {
      if (selectedSessionRef.current === sessionId) void loadSession(sessionId);
      return;
    }
    const previousRevision = revisionsRef.current[sessionId] || 0;
    if (revision && previousRevision && revision !== previousRevision + 1) {
      staleSessionIdsRef.current.add(sessionId);
      if (selectedSessionRef.current === sessionId) void loadSession(sessionId);
      return;
    }
    if (revision) revisionsRef.current[sessionId] = revision;
    if (name === "session.message.upsert" && data.message) {
      const message = data.message as RemoteChatMessage;
      setMessages((current) => {
        const list = [...(current[sessionId] || [])];
        const index = list.findIndex((item) => item.id === message.id);
        if (index >= 0) list[index] = message;
        else list.push(message);
        return { ...current, [sessionId]: list };
      });
    } else if (name === "session.messages.replace" && Array.isArray(data.messages)) {
      setMessages((current) => ({ ...current, [sessionId]: data.messages as RemoteChatMessage[] }));
    } else if (name === "session.queue.updated" && Array.isArray(data.queue)) {
      setQueues((current) => ({ ...current, [sessionId]: data.queue as RemoteQueuedMessage[] }));
    } else if (name === "session.interaction.updated") {
      setInteractions((current) => ({ ...current, [sessionId]: (data.interaction as RemoteInteraction | null) || null }));
    } else if (name === "session.config.updated" && data.config) {
      const config = data.config as RemoteSessionConfig;
      const previousConfig = configsRef.current[sessionId];
      const previousModel = previousConfig?.model;
      const nextModel = config.model;
      if (
        selectedSessionRef.current === sessionId &&
        previousConfig &&
        nextModel && (
          !previousModel ||
          previousModel.id !== nextModel.id ||
          previousModel.provider !== nextModel.provider
        )
      ) {
        const target = findSession(projectsRef.current, sessionId);
        const agent = agentsRef.current.find((candidate) => candidate.id === target?.session.agentId);
        showFloatingToast(formatModelSwitchToastText(
          agent?.requiresProviderActivation === true,
          nextModel.provider,
          nextModel.name || nextModel.id,
        ));
      }
      applySessionConfig(sessionId, config);
      if (config.availableModels === undefined && selectedSessionRef.current === sessionId) {
        void clientRef.current?.request<RemoteSessionConfig>("session.models.get", { sessionId }).then((nextConfig) => {
          applySessionConfig(sessionId, nextConfig);
        }).catch(() => undefined);
      }
    }
  }, [applyCatalog, applySessionConfig, loadCatalog, loadSession, showFloatingToast]);

  const connectHost = useCallback((host: PairedHost) => {
    autoConnectAttemptedRef.current = true;
    setLastHostId(host.id);
    void saveLastPairedHostId(host.id).catch((err) => {
      setError(`无法记住此桌面：${err instanceof Error ? err.message : String(err)}`);
    });
    clientRef.current?.disconnect();
    setError("");
    activeHostRef.current = host;
    setActiveHost(host);
    setProjects([]);
    setAgents([]);
    setSelectedSessionId(null);
    setHistoryOpen(false);
    setMessages({});
    setNextBefore({});
    setQueues({});
    setInteractions({});
    setConfigs({});
    revisionsRef.current = {};
    requiredSessionRevisionsRef.current = {};
    unrevisionedSessionEventVersionsRef.current = {};
    sessionLoadGenerationsRef.current = {};
    staleSessionIdsRef.current.clear();
    loadingSessionIdsRef.current.clear();
    reloadAfterSessionLoadRef.current.clear();
    hostEpochRef.current = null;
    const client = new RemoteClient(host);
    clientRef.current = client;
    client.onHostUpdated((nextHost) => {
      if (clientRef.current !== client) return;
      activeHostRef.current = nextHost;
      setActiveHost(nextHost);
      setHosts((current) => {
        const next = current.map((item) => item.id === nextHost.id ? nextHost : item);
        void savePairedHosts(next).catch((err) => {
          setError(`无法记住自动选择的连接地址：${err instanceof Error ? err.message : String(err)}`);
        });
        return next;
      });
    });
    client.onState((state) => {
      if (clientRef.current !== client) return;
      setConnectionState(state);
      if (state === "disconnected") {
        staleSessionIdsRef.current = new Set([
          ...staleSessionIdsRef.current,
          ...Object.keys(revisionsRef.current),
          ...Object.keys(configsRef.current),
        ]);
        for (const sessionId of loadingSessionIdsRef.current) {
          reloadAfterSessionLoadRef.current.add(sessionId);
        }
      }
      if (state === "connected") {
        void loadCatalog(client).then(() => {
          const sessionId = selectedSessionRef.current;
          if (sessionId) void loadSession(sessionId);
        }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    });
    client.onEvent(handleRemoteEvent);
    void client.connect();
  }, [handleRemoteEvent, loadCatalog, loadSession]);

  const openSavedHost = useCallback((host: PairedHost, availability: HostAvailability) => {
    if (availability !== "online") {
      showFloatingToast(availability === "offline"
        ? "桌面当前离线，请启动桌面 Hpp 后重试"
        : "正在检测桌面状态，请稍后重试");
      void probeHostAvailability(host).then((next) => {
        setHostAvailability((current) => ({ ...current, [host.id]: next }));
      });
      return;
    }
    connectHost(host);
  }, [connectHost, showFloatingToast]);

  useEffect(() => {
    if (
      demoMode || !hostsLoaded || activeHost || autoConnectAttemptedRef.current ||
      incomingWebPairingRef.current || hosts.length === 0
    ) return;
    const remembered = hosts.find((host) => host.id === lastHostId) || (hosts.length === 1 ? hosts[0] : null);
    if (!remembered) return;
    const availability = hostAvailability[remembered.id];
    if (!availability || availability === "checking") return;
    autoConnectAttemptedRef.current = true;
    if (availability === "online") connectHost(remembered);
  }, [activeHost, connectHost, demoMode, hostAvailability, hosts, hostsLoaded, lastHostId]);

  useEffect(() => {
    let listener: { remove: () => Promise<void> } | undefined;
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        void clientRef.current?.connect();
        const stage = updateStageRef.current;
        if (stage === "downloading" || stage === "permission") {
          void syncAndroidUpdateDownload(true);
        } else if (stage === "downloaded") {
          void syncAndroidUpdateDownload(false);
        } else if (stage !== "installing") {
          void checkAndroidUpdate(false);
        }
      } else {
        flushCurrentDraft();
      }
    }).then((handle) => { listener = handle; });
    return () => { void listener?.remove(); };
  }, [checkAndroidUpdate, flushCurrentDraft, syncAndroidUpdateDownload]);

  useEffect(() => () => clientRef.current?.disconnect(), []);

  useEffect(() => {
    if (!composerAddMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!composerAddMenuRef.current?.contains(event.target as Node)) setComposerAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [composerAddMenuOpen]);

  useEffect(() => {
    if (!editingHostId) return;
    const closeEditor = (event: PointerEvent) => {
      const target = event.target as Node;
      if (editingHostFormRef.current?.contains(target) || editingHostTriggerRef.current?.contains(target)) return;
      if (!savingHostId) setEditingHostId(null);
    };
    document.addEventListener("pointerdown", closeEditor);
    return () => document.removeEventListener("pointerdown", closeEditor);
  }, [editingHostId, savingHostId]);

  useEffect(() => {
    // Pause availability updates while editing a desktop. In mobile WebView,
    // the periodic state update can otherwise repaint the controlled form and
    // make an in-progress note appear to reset while typing.
    if (demoMode || !hostsLoaded || activeHost || editingHostId || hosts.length === 0) return;
    let disposed = false;
    let probing = false;

    const probeSavedHosts = async (showChecking: boolean) => {
      if (disposed || probing) return;
      probing = true;
      if (showChecking) {
        setHostAvailability((current) => Object.fromEntries(
          hosts.map((host) => [host.id, current[host.id] || "checking"]),
        ));
      }
      try {
        const results = await Promise.all(hosts.map(async (host) => [
          host.id,
          await probeHostAvailability(host),
        ] as const));
        if (!disposed) {
          const next = Object.fromEntries(results);
          setHostAvailability((current) => {
            const currentKeys = Object.keys(current);
            const nextKeys = Object.keys(next);
            if (currentKeys.length === nextKeys.length
              && nextKeys.every((id) => current[id] === next[id])) return current;
            return next;
          });
        }
      } finally {
        probing = false;
      }
    };

    void probeSavedHosts(true);
    const interval = window.setInterval(() => void probeSavedHosts(false), 10_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void probeSavedHosts(false);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeHost, demoMode, editingHostId, hosts, hostsLoaded]);

  const refreshPairedHosts = useCallback(async () => {
    if (refreshingHosts) return;
    setRefreshingHosts(true);
    try {
      const refreshedHosts = demoMode ? hostsRef.current : await loadPairedHosts();
      hostsRef.current = refreshedHosts;
      setHosts(refreshedHosts);
      setHostAvailability(Object.fromEntries(refreshedHosts.map((host) => [host.id, "checking" as const])));
      const results = await Promise.all(refreshedHosts.map(async (host) => [
        host.id,
        await probeHostAvailability(host),
      ] as const));
      setHostAvailability(Object.fromEntries(results));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      hostPullStartRef.current = null;
      hostPullDistanceRef.current = 0;
      setHostPullDistance(0);
      setRefreshingHosts(false);
    }
  }, [demoMode, refreshingHosts]);

  const handleHostPullStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (refreshingHosts || editingHostId || pairingMode !== "closed" || event.currentTarget.scrollTop > 0) return;
    hostPullStartRef.current = event.touches[0]?.clientY ?? null;
    hostPullDistanceRef.current = 0;
  }, [editingHostId, pairingMode, refreshingHosts]);

  const handleHostPullMove = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const start = hostPullStartRef.current;
    const currentY = event.touches[0]?.clientY;
    if (start === null || currentY === undefined || event.currentTarget.scrollTop > 0) return;
    const distance = Math.min(84, Math.max(0, (currentY - start) * 0.45));
    hostPullDistanceRef.current = distance;
    setHostPullDistance(distance);
  }, []);

  const handleHostPullEnd = useCallback(() => {
    if (hostPullStartRef.current === null) return;
    const shouldRefresh = hostPullDistanceRef.current >= 52;
    hostPullStartRef.current = null;
    if (shouldRefresh) {
      void refreshPairedHosts();
      return;
    }
    hostPullDistanceRef.current = 0;
    setHostPullDistance(0);
  }, [refreshPairedHosts]);

  const pairFromLink = useCallback(async (link: string) => {
    setPairingBusy(true);
    setError("");
    try {
      const deviceKind = IS_NATIVE_APP ? "Android" : "Web";
      const host = await pairHost(link, `${deviceKind} ${navigator.platform || "device"}`);
      const next = [...hosts.filter((item) => item.hostId !== host.hostId), host];
      await updateHosts(next);
      setPairingMode("closed");
      setPairingLink("");
      connectHost(host);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairingBusy(false);
    }
  }, [connectHost, hosts, updateHosts]);

  useEffect(() => {
    if (demoMode || IS_NATIVE_APP || !hostsLoaded) return;
    const pairingLink = incomingWebPairingRef.current;
    if (!pairingLink) return;
    incomingWebPairingRef.current = null;
    autoConnectAttemptedRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("pair");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    void pairFromLink(pairingLink);
  }, [demoMode, hostsLoaded, pairFromLink]);

  useEffect(() => {
    let listener: { remove: () => Promise<void> } | undefined;
    void CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      if (url.startsWith("hpp://pair")) void pairFromLink(url);
    }).then((handle) => { listener = handle; });
    return () => { void listener?.remove(); };
  }, [pairFromLink]);

  const scanPairing = useCallback(async () => {
    setPairingBusy(true);
    setError("");
    try {
      const module = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!module.available) {
        await BarcodeScanner.installGoogleBarcodeScannerModule();
        throw new Error("扫码组件正在安装，请稍后重试。");
      }
      const result = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode], autoZoom: true });
      const value = result.barcodes[0]?.rawValue || result.barcodes[0]?.displayValue;
      if (!value) throw new Error("没有读取到二维码。");
      await pairFromLink(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairingBusy(false);
    }
  }, [pairFromLink]);

  const selectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setDrawerOpen(false);
    setHistoryOpen(false);
    void loadSession(sessionId);
  }, [loadSession]);

  const selected = useMemo(() => findSession(projects, selectedSessionId), [projects, selectedSessionId]);
  const openSessionCount = useMemo(
    () => projects.reduce((count, project) => count + project.sessions.filter((session) => !session.closed).length, 0),
    [projects],
  );
  const historyProject = useMemo(
    () => projects.find((project) => project.id === historyProjectId) || null,
    [historyProjectId, projects],
  );
  const historyProjectSessions = useMemo(
    () => historyProject?.sessions
      .filter((session) => session.closed)
      .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt)) || [],
    [historyProject],
  );
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selected?.session.agentId),
    [agents, selected?.session.agentId],
  );
  const selectedConfig = selectedSessionId ? configs[selectedSessionId] : undefined;
  const selectedMessages = useMemo(
    () => selectedSessionId ? messages[selectedSessionId] || [] : [],
    [messages, selectedSessionId],
  );
  const receivedUserMessages = useMemo(() => {
    const byAssistantId: Record<string, RemoteChatMessage> = {};
    let latestUserMessage: RemoteChatMessage | undefined;
    for (const message of selectedMessages) {
      if (message.role === "user") {
        latestUserMessage = message;
      } else if (message.role === "assistant" && message.process && latestUserMessage) {
        byAssistantId[message.id] = latestUserMessage;
      }
    }
    return byAssistantId;
  }, [selectedMessages]);
  const activeTurnMessageId = useMemo(
    () => getActiveAssistantTurnId(selectedMessages, selected?.session.status === "running"),
    [selected?.session.status, selectedMessages],
  );
  const processTerminalState: ProcessTerminalViewState = selected?.session.status === "error"
    ? "error"
    : "completed";
  const selectedModels = useMemo(() => {
    return includeCurrentModel(selectedConfig?.availableModels || [], selectedConfig?.model);
  }, [selectedConfig]);
  const thinkingLevels = useMemo(
    () => getModelThinkingLevels(selectedConfig?.model),
    [selectedConfig?.model],
  );
  const selectedUserMessages = useMemo(
    () => selectedMessages.filter((message) => message.role === "user").slice().reverse(),
    [selectedMessages],
  );
  const referenceCandidates = useMemo(
    () => selected ? selected.project.sessions.filter((session) => session.id !== selected.session.id) : [],
    [selected],
  );
  const selectedReferenceSessions = useMemo(
    () => referenceCandidates.filter((session) => pendingReferenceIds.includes(session.id)),
    [pendingReferenceIds, referenceCandidates],
  );
  const selectedQueue = selectedSessionId ? queues[selectedSessionId] || [] : [];
  const selectedInteraction = selectedSessionId ? interactions[selectedSessionId] : null;
  const isConnected = connectionState === "connected";
  const composerAction = getComposerAction({
    text: composer,
    composingText: composerComposition,
    imageCount: pendingImages.length,
    referenceCount: selectedReferenceSessions.length,
    actionCount: pendingAction ? 1 : 0,
    running: selected?.session.status === "running",
  });
  const composerHasContent = composerAction === "send";
  const showAbortButton = composerAction === "abort";
  const queueSend = selected?.session.status === "running" && composerHasContent;

  const updateComposer = useCallback((value: string) => {
    draftValueRef.current = { ...draftValueRef.current, text: value };
    setComposer((current) => current === value ? current : value);
  }, []);

  const updateComposerDocument = useCallback((document: ComposerDocument) => {
    const migratedImages = getComposerImageNodes(document).flatMap((node): PendingRemoteImage[] => {
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(node.src);
      if (!match) return [];
      return [{ id: node.id, name: node.name, mimeType: node.mimeType as PendingRemoteImage["mimeType"], data: match[2], preview: node.src }];
    });
    const orderedDocument = withoutComposerImages(document);
    const text = getComposerPlainText(orderedDocument);
    setComposerDocument(orderedDocument);
    updateComposer(text);
    if (migratedImages.length > 0) {
      setPendingImages((current) => {
        const next = [...current];
        for (const image of migratedImages) if (!next.some((item) => item.id === image.id)) next.push(image);
        return next;
      });
    }
    setPendingReferenceIds(orderedDocument.nodes.flatMap((node) => node.type === "session" ? [node.reference.sourceSessionId] : []));
  }, [updateComposer]);

  const handleComposerChange = useCallback((document: ComposerDocument) => {
    // Lexical 编辑器不经过 scheduleComposerSync（composerRef 仅用于
    // 普通 textarea 路径），必须在用户输入路径上标记已编辑，
    // 否则草稿异步加载完成时会把正在输入的内容覆盖/清空。
    draftUserEditedRef.current = true;
    updateComposerDocument(document);
  }, [updateComposerDocument]);
  const handleComposerCompositionStartInline = useCallback(() => setComposerComposition(" "), []);
  const handleComposerCompositionEndInline = useCallback(() => setComposerComposition(""), []);

  const syncComposerFromElement = useCallback((textarea: HTMLTextAreaElement | null = composerRef.current) => {
    if (!textarea) return;
    updateComposer(textarea.value);
  }, [updateComposer]);

  const scheduleComposerSync = useCallback((textarea: HTMLTextAreaElement) => {
    draftUserEditedRef.current = true;
    syncComposerFromElement(textarea);
    queueMicrotask(() => {
      if (composerRef.current === textarea) syncComposerFromElement(textarea);
    });
    requestAnimationFrame(() => {
      if (composerRef.current === textarea) syncComposerFromElement(textarea);
    });
  }, [syncComposerFromElement]);

  const handleComposerBeforeInput = useCallback((event: ReactFormEvent<HTMLTextAreaElement>) => {
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.isComposing && inputEvent.data) setComposerComposition(inputEvent.data);
    scheduleComposerSync(event.currentTarget);
  }, [scheduleComposerSync]);

  const handleComposerComposition = useCallback((event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    setComposerComposition(event.data || event.currentTarget.value || " ");
    scheduleComposerSync(event.currentTarget);
  }, [scheduleComposerSync]);

  const handleComposerCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    setComposerComposition("");
    scheduleComposerSync(event.currentTarget);
  }, [scheduleComposerSync]);

  const replaceComposer = useCallback((value: string) => {
    const textarea = composerRef.current;
    if (textarea && textarea.value !== value) textarea.value = value;
    setComposerComposition("");
    updateComposerDocument(createComposerDocument(value
      ? [{ id: createClientId(), type: "text", text: value }]
      : []));
  }, [updateComposerDocument]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      if (textarea.value !== draftValueRef.current.text) updateComposer(textarea.value);
    };
    const schedule = () => scheduleComposerSync(textarea);
    const onBeforeInput = (event: InputEvent) => {
      if (event.isComposing && event.data) setComposerComposition(event.data);
      schedule();
    };
    const onComposition = (event: CompositionEvent) => {
      setComposerComposition(event.data || textarea.value || "");
      schedule();
    };
    const onCompositionEnd = () => {
      setComposerComposition("");
      schedule();
    };
    const stop = () => {
      sync();
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      sync();
      if (!timer) timer = setInterval(sync, 100);
    };

    textarea.addEventListener("focus", start);
    textarea.addEventListener("blur", stop);
    textarea.addEventListener("input", sync);
    textarea.addEventListener("beforeinput", onBeforeInput);
    textarea.addEventListener("compositionstart", onComposition);
    textarea.addEventListener("compositionupdate", onComposition);
    textarea.addEventListener("compositionend", onCompositionEnd);
    if (document.activeElement === textarea) start();
    return () => {
      textarea.removeEventListener("focus", start);
      textarea.removeEventListener("blur", stop);
      textarea.removeEventListener("input", sync);
      textarea.removeEventListener("beforeinput", onBeforeInput);
      textarea.removeEventListener("compositionstart", onComposition);
      textarea.removeEventListener("compositionupdate", onComposition);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      if (timer) clearInterval(timer);
    };
  }, [scheduleComposerSync, updateComposer]);

  const handleMessagesScroll = useCallback(() => {
    const view = messagesViewRef.current;
    if (!view) return;
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight <= 48;
    if (returningToBottomRef.current) {
      if (atBottom) returningToBottomRef.current = false;
      followMessageBottomRef.current = true;
      setShowReturnToBottom(false);
      return;
    }
    followMessageBottomRef.current = atBottom;
    setShowReturnToBottom(!atBottom);
  }, []);

  const cancelReturnToBottom = useCallback(() => {
    returningToBottomRef.current = false;
  }, []);

  const returnToMessageBottom = useCallback(() => {
    const view = messagesViewRef.current;
    if (!view) return;
    returningToBottomRef.current = true;
    followMessageBottomRef.current = true;
    setShowReturnToBottom(false);
    view.scrollTo({ top: view.scrollHeight, behavior: "smooth" });
  }, []);

  useLayoutEffect(() => {
    followMessageBottomRef.current = true;
    returningToBottomRef.current = false;
    setShowReturnToBottom(false);
    const view = messagesViewRef.current;
    if (view) view.scrollTop = view.scrollHeight;
  }, [selectedSessionId]);

  useEffect(() => {
    flushCurrentDraft();

    setComposerAddMenuOpen(false);
    setReferenceSheetOpen(false);
    setActionSheetOpen(false);
    setActionCatalog([]);
    setActionError("");
    setPendingImages([]);
    replaceComposer("");
    setPendingReferenceIds([]);
    setPendingAction(undefined);
    draftValueRef.current = { text: "", referenceSessionIds: [] };
    loadedDraftKeyRef.current = null;
    draftUserEditedRef.current = false;

    const hostId = activeHost?.hostId;
    if (demoMode || !hostId || !selectedSessionId) {
      draftIdentityRef.current = null;
      return;
    }

    const identity = { hostId, sessionId: selectedSessionId, key: `${hostId}:${selectedSessionId}` };
    draftIdentityRef.current = identity;
    let cancelled = false;
    void loadSessionDraft(hostId, selectedSessionId).then((draft) => {
      if (cancelled || draftIdentityRef.current?.key !== identity.key) return;
      const target = findSession(projectsRef.current, selectedSessionId);
      const validReferenceIds = new Set(
        target?.project.sessions.filter((session) => session.id !== selectedSessionId).map((session) => session.id) || [],
      );
      const referenceSessionIds = (draft?.referenceSessionIds || []).filter((id) => validReferenceIds.has(id));
      const nextDraft: ComposerDraftValue = {
        text: draft?.text || "",
        document: draft?.document,
        referenceSessionIds,
        action: selectedAgent?.supportsActions === true ? draft?.action : undefined,
      };
      // 用户在草稿加载完成前已经开始输入：保留当前输入，不再用旧草稿覆盖。
      if (!draftUserEditedRef.current) {
        draftValueRef.current = nextDraft;
        if (nextDraft.document) {
          updateComposerDocument(createComposerDocument(nextDraft.document.nodes.filter((node) =>
            node.type !== "session" || validReferenceIds.has(node.reference.sourceSessionId)
          )));
        } else {
          replaceComposer(nextDraft.text);
        }
        setPendingReferenceIds(nextDraft.referenceSessionIds);
        setPendingAction(nextDraft.action);
      }
      loadedDraftKeyRef.current = identity.key;
    }).catch((error) => console.error("[mobile-draft] load failed", error));
    return () => { cancelled = true; };
  }, [activeHost?.hostId, demoMode, flushCurrentDraft, replaceComposer, selectedAgent?.supportsActions, selectedSessionId, updateComposerDocument]);

  useEffect(() => {
    const identity = draftIdentityRef.current;
    if (!identity) return;
    if (loadedDraftKeyRef.current !== identity.key && !draftUserEditedRef.current) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      void saveSessionDraft(identity.hostId, identity.sessionId, draftValueRef.current)
        .catch((error) => console.error("[mobile-draft] save failed", error));
    }, 300);
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, [composer, composerDocument, pendingAction, pendingReferenceIds]);

  useEffect(() => {
    const handlePageHide = () => flushCurrentDraft();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushCurrentDraft();
    };
    const handleBeforeUnload = () => flushCurrentDraft();
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      flushCurrentDraft();
    };
  }, [flushCurrentDraft]);

  useLayoutEffect(() => {
    const view = messagesViewRef.current;
    if (!view) return;
    if (followMessageBottomRef.current) {
      view.scrollTop = view.scrollHeight;
      setShowReturnToBottom(false);
      return;
    }
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight <= 48;
    setShowReturnToBottom(!atBottom);
  }, [composer, pendingImages.length, selectedInteraction, selectedMessages, selectedQueue.length]);

  const openHistoryMessage = useCallback((messageId: string) => {
    setHistoryOpen(false);
    followMessageBottomRef.current = false;
    returningToBottomRef.current = false;
    setShowReturnToBottom(true);
    requestAnimationFrame(() => {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const editMessage = useCallback((content: string) => {
    replaceComposer(content);
    requestAnimationFrame(() => inlineComposerRef.current?.focus());
  }, [replaceComposer]);

  const runCommand = useCallback(async <T,>(name: Parameters<RemoteClient["request"]>[0], payload: Record<string, unknown>) => {
    const client = clientRef.current;
    if (!client) throw new Error("Desktop is not connected.");
    setCommandBusy(true);
    setError("");
    try {
      return await client.request<T>(name, payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setCommandBusy(false);
    }
  }, []);

  const loadAgentActions = useCallback(async (reload = false) => {
    if (!selectedSessionId || selectedAgent?.supportsActions !== true) {
      setActionCatalog([]);
      setActionError("");
      return;
    }
    setActionLoading(true);
    setActionError("");
    try {
      const actions = demoMode
        ? DEMO_ACTIONS
        : (await clientRef.current?.request<{ actions: RemoteAgentAction[] }>("session.actions.get", {
            sessionId: selectedSessionId,
            reload,
          }))?.actions || [];
      setActionCatalog(actions);
      const selectedDraftAction = draftValueRef.current.action;
      if (
        selectedDraftAction &&
        !actions.some((entry) => entry.kind === selectedDraftAction.kind && entry.name === selectedDraftAction.name)
      ) {
        draftValueRef.current = { ...draftValueRef.current, action: undefined };
        setPendingAction(undefined);
        showFloatingToast("所选技能或命令已失效，已从草稿中移除");
      }
    } catch (actionLoadError) {
      setActionError(actionLoadError instanceof Error ? actionLoadError.message : String(actionLoadError));
    } finally {
      setActionLoading(false);
    }
  }, [demoMode, selectedAgent?.supportsActions, selectedSessionId, showFloatingToast]);

  const openActionSheet = useCallback(() => {
    if (selectedAgent?.supportsActions !== true) return;
    setComposerAddMenuOpen(false);
    setActionSheetOpen(true);
    void loadAgentActions(false);
  }, [loadAgentActions, selectedAgent?.supportsActions]);

  const selectAgentAction = useCallback((action: RemoteAgentActionInvocation) => {
    draftValueRef.current = { ...draftValueRef.current, action };
    setPendingAction(action);
    setActionSheetOpen(false);
    requestAnimationFrame(() => inlineComposerRef.current?.focus());
  }, []);

  const clearAgentAction = useCallback(() => {
    draftValueRef.current = { ...draftValueRef.current, action: undefined };
    setPendingAction(undefined);
  }, []);

  const applySessionResult = useCallback((result: RemoteSessionCreateResult) => {
    setProjects((current) => current.map((project) => project.id === result.projectId
      ? {
          ...project,
          sessions: project.sessions.map((session) => session.id === result.session.id ? result.session : session),
        }
      : project));
    setConfigs((current) => ({
      ...current,
      [result.session.id]: {
        ...current[result.session.id],
        ...result.config,
        availableModels: result.config.availableModels ?? current[result.session.id]?.availableModels,
      },
    }));
  }, []);

  const setDemoSessionClosed = useCallback((projectId: string, sessionId: string, closed: boolean) => {
    const now = new Date().toISOString();
    setProjects((current) => current.map((project) => project.id === projectId
      ? {
          ...project,
          sessions: project.sessions.map((session) => session.id === sessionId
            ? { ...session, closed, lastActiveAt: now, ...(closed ? { status: "idle" as const } : {}) }
            : session),
        }
      : project));
  }, []);

  const closeRemoteSession = useCallback(async (project: RemoteProject, session: RemoteSession) => {
    if (commandBusy || session.closed) return;
    try {
      if (demoMode) {
        setDemoSessionClosed(project.id, session.id, true);
      } else {
        const result = await runCommand<RemoteSessionCreateResult>("session.close", { sessionId: session.id });
        applySessionResult(result);
      }
      if (selectedSessionId === session.id) {
        const fallback = [
          ...project.sessions.filter((candidate) => candidate.id !== session.id && !candidate.closed),
          ...projects.filter((candidate) => candidate.id !== project.id).flatMap((candidate) => candidate.sessions.filter((item) => !item.closed)),
        ][0];
        setSelectedSessionId(fallback?.id || null);
        setHistoryOpen(false);
        if (fallback) void loadSession(fallback.id);
      }
    } catch {
      // runCommand keeps the error visible on mobile.
    }
  }, [applySessionResult, commandBusy, demoMode, loadSession, projects, runCommand, selectedSessionId, setDemoSessionClosed]);

  const reopenRemoteSession = useCallback(async (project: RemoteProject, session: RemoteSession) => {
    if (commandBusy || !session.closed) return;
    try {
      if (demoMode) {
        setDemoSessionClosed(project.id, session.id, false);
      } else {
        const result = await runCommand<RemoteSessionCreateResult>("session.reopen", { sessionId: session.id });
        applySessionResult(result);
      }
      setSelectedSessionId(session.id);
      setDrawerOpen(false);
      setHistoryOpen(false);
      setHistoryProjectId(null);
      if (!demoMode || !messages[session.id]) void loadSession(session.id);
    } catch {
      // runCommand keeps the error visible on mobile.
    }
  }, [applySessionResult, commandBusy, demoMode, loadSession, messages, runCommand, setDemoSessionClosed]);

  const switchModel = useCallback(async (model: RemoteModel) => {
    if (!selected) return;
    const previous = configs[selected.session.id]?.model;
    if (previous?.id === model.id && previous.provider === model.provider) return;
    if (demoMode) {
      setConfigs((current) => ({
        ...current,
        [selected.session.id]: { ...current[selected.session.id], model },
      }));
      showFloatingToast(formatModelSwitchToastText(
        selectedAgent?.requiresProviderActivation === true,
        model.provider,
        model.name || model.id,
      ));
      return;
    }
    try {
      const config = await runCommand<RemoteSessionConfig>("session.setModel", {
        sessionId: selected.session.id,
        provider: model.provider,
        modelId: model.id,
      });
      setConfigs((current) => ({ ...current, [selected.session.id]: config }));
    } catch {
      // runCommand keeps the error visible on mobile.
    }
  }, [configs, demoMode, runCommand, selected, selectedAgent?.requiresProviderActivation, showFloatingToast]);

  const reloadCurrentSession = useCallback(async () => {
    if (!selected || commandBusy || reloadingSession || selected.session.status === "running") return;
    setReloadingSession(true);
    try {
      if (demoMode) {
        setReloadConfirmOpen(false);
        showFloatingToast(`${selectedAgent?.name || selected.session.agentId} 当前会话已重新打开`);
        return;
      }
      const result = await runCommand<{ reloaded: boolean; config: RemoteSessionConfig }>("session.reload", {
        sessionId: selected.session.id,
      });
      setConfigs((current) => ({ ...current, [selected.session.id]: result.config }));
      setReloadConfirmOpen(false);
      showFloatingToast(result.reloaded
        ? `${selectedAgent?.name || selected.session.agentId} 当前会话已重新打开`
        : `${selectedAgent?.name || selected.session.agentId} 当前会话无需重载`);
    } catch {
      // runCommand keeps the error visible while the confirmation sheet remains open.
    } finally {
      setReloadingSession(false);
    }
  }, [commandBusy, demoMode, reloadingSession, runCommand, selected, selectedAgent?.name, showFloatingToast]);

  useEffect(() => {
    setReloadConfirmOpen(false);
    setReloadingSession(false);
    setEditingQueueItem(null);
  }, [selectedSessionId]);

  const guideQueuedMessage = useCallback(async (item: RemoteQueuedMessage) => {
    if (
      !selected || commandBusy || selected.session.status !== "running" ||
      selectedAgent?.supportsGuidance !== true || item.status === "sending"
    ) return;
    if (demoMode) {
      setQueues((current) => ({
        ...current,
        [selected.session.id]: (current[selected.session.id] || []).filter((queued) => queued.id !== item.id),
      }));
      showFloatingToast("已转为引导");
      return;
    }

    setQueues((current) => ({
      ...current,
      [selected.session.id]: (current[selected.session.id] || []).map((queued) =>
        queued.id === item.id ? { ...queued, status: "sending", error: undefined } : queued),
    }));
    try {
      await runCommand("session.queue.guide", {
        sessionId: selected.session.id,
        queueItemId: item.id,
      });
      setQueues((current) => ({
        ...current,
        [selected.session.id]: (current[selected.session.id] || []).filter((queued) => queued.id !== item.id),
      }));
      showFloatingToast("已转为引导");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setQueues((current) => ({
        ...current,
        [selected.session.id]: (current[selected.session.id] || []).map((queued) =>
          queued.id === item.id ? { ...queued, status: "failed", error: message } : queued),
      }));
    }
  }, [commandBusy, demoMode, runCommand, selected, selectedAgent?.supportsGuidance, showFloatingToast]);

  const removeQueuedMessage = useCallback(async (item: RemoteQueuedMessage) => {
    if (!selected || commandBusy || item.status === "sending") return;
    if (!demoMode) {
      try {
        await runCommand("session.queue.remove", {
          sessionId: selected.session.id,
          queueItemId: item.id,
        });
      } catch {
        return;
      }
    }
    setQueues((current) => ({
      ...current,
      [selected.session.id]: (current[selected.session.id] || []).filter((queued) => queued.id !== item.id),
    }));
  }, [commandBusy, demoMode, runCommand, selected]);

  const reorderQueuedMessage = useCallback(async (itemId: string, toIndex: number) => {
    if (!selected || commandBusy) return;
    const queue = queues[selected.session.id] || [];
    const fromIndex = queue.findIndex((item) => item.id === itemId);
    if (fromIndex < 0 || queue[fromIndex].status === "sending") return;
    const boundedIndex = Math.max(0, Math.min(toIndex, queue.length - 1));
    if (boundedIndex === fromIndex) return;
    if (!demoMode) {
      try {
        await runCommand("session.queue.reorder", {
          sessionId: selected.session.id,
          queueItemId: itemId,
          toIndex: boundedIndex,
        });
      } catch {
        return;
      }
    }
    setQueues((current) => {
      const currentQueue = current[selected.session.id] || [];
      const currentIndex = currentQueue.findIndex((item) => item.id === itemId);
      if (currentIndex < 0) return current;
      const next = currentQueue.slice();
      const [moved] = next.splice(currentIndex, 1);
      next.splice(Math.max(0, Math.min(boundedIndex, next.length)), 0, moved);
      return { ...current, [selected.session.id]: next };
    });
  }, [commandBusy, demoMode, queues, runCommand, selected]);

  const saveQueuedMessage = useCallback(async (draft: QueueEditDraft) => {
    if (!selected || !editingQueueItem || commandBusy || editingQueueItem.status === "sending") return;
    const images = draft.images.map((image) => {
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(image.src);
      if (!match) throw new Error(`无法读取图片：${image.name}`);
      return {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType || match[1],
        data: match[2],
      };
    });
    const sessionReferences = draft.sessionReferences.map(({ sourceSessionId }) => ({ sourceSessionId }));
    if (!demoMode) {
      await runCommand("session.queue.edit", {
        sessionId: selected.session.id,
        queueItemId: editingQueueItem.id,
        content: draft.content,
        images,
        sessionReferences,
        composerDocument: remoteComposerDocument(draft.composerDocument),
        retainedAttachmentIds: draft.attachments.map((attachment) => attachment.id),
        action: draft.action || null,
      });
    }

    const displayContent = draft.content.trim()
      || (draft.images.length > 0 ? "请查看附件图片。" : "")
      || (draft.sessionReferences.length > 0 ? `引用会话：${draft.sessionReferences.map((reference) => reference.sourceTitle).join("、")}` : "")
      || (draft.attachments.length > 0 ? `附件：${draft.attachments.map((attachment) => attachment.name).join("、")}` : "")
      || (draft.action ? `${draft.action.kind === "skill" ? "技能" : "命令"} · ${draft.action.name}` : "");
    setQueues((current) => ({
      ...current,
      [selected.session.id]: (current[selected.session.id] || []).map((item) => item.id === editingQueueItem.id
        ? {
            ...item,
            editableContent: draft.content,
            displayContent,
            images: draft.images,
            sessionReferences: draft.sessionReferences,
            attachments: draft.attachments,
            composerDocument: remoteComposerDocument(draft.composerDocument),
            action: draft.action,
            status: "queued",
            error: undefined,
          }
        : item),
    }));
    showFloatingToast("队列消息已更新");
  }, [commandBusy, demoMode, editingQueueItem, runCommand, selected, showFloatingToast]);

  const openSessionCreator = useCallback((project: RemoteProject) => {
    setCreateProject(project);
    setCreateAgentId(agents[0]?.id || "");
    setCreateSessionId(createClientId());
  }, [agents]);

  const createRemoteSession = useCallback(async () => {
    if (!createProject || !createAgentId || !createSessionId) return;
    try {
      const result = await runCommand<RemoteSessionCreateResult>("session.create", {
        projectId: createProject.id,
        agentId: createAgentId,
        clientSessionId: createSessionId,
      });
      setProjects((current) => current.map((project) => project.id === result.projectId
        ? {
            ...project,
            sessions: project.sessions.some((session) => session.id === result.session.id)
              ? project.sessions.map((session) => session.id === result.session.id ? result.session : session)
              : [...project.sessions, result.session],
          }
        : project));
      setConfigs((current) => ({ ...current, [result.session.id]: result.config }));
      setMessages((current) => ({ ...current, [result.session.id]: current[result.session.id] || [] }));
      setNextBefore((current) => ({ ...current, [result.session.id]: null }));
      setQueues((current) => ({ ...current, [result.session.id]: current[result.session.id] || [] }));
      setInteractions((current) => ({ ...current, [result.session.id]: null }));
      setSelectedSessionId(result.session.id);
      setCreateProject(null);
      setCreateSessionId("");
      setDrawerOpen(false);
      if (result.warning) setError(`会话已创建，但 Agent 初始化失败：${result.warning}`);
    } catch {
      // runCommand keeps the error visible and the sheet open for retry.
    }
  }, [createAgentId, createProject, createSessionId, runCommand]);

  const forkMessage = useCallback(async (message: RemoteChatMessage) => {
    if (!selected || message.role !== "assistant" || forkingMessageId) return;
    const forkKey = `${selected.session.id}:${message.id}`;
    const clientSessionId = forkSessionIdsRef.current.get(forkKey) || createClientId();
    forkSessionIdsRef.current.set(forkKey, clientSessionId);
    setForkingMessageId(message.id);
    try {
      const result = await runCommand<RemoteSessionCreateResult>("session.fork", {
        sessionId: selected.session.id,
        throughMessageId: message.id,
        clientSessionId,
      });
      setProjects((current) => current.map((project) => project.id === result.projectId
        ? {
            ...project,
            sessions: project.sessions.some((session) => session.id === result.session.id)
              ? project.sessions.map((session) => session.id === result.session.id ? result.session : session)
              : [...project.sessions, result.session],
          }
        : project));
      setConfigs((current) => ({ ...current, [result.session.id]: result.config }));
      setMessages((current) => ({ ...current, [result.session.id]: current[result.session.id] || [] }));
      setNextBefore((current) => ({ ...current, [result.session.id]: null }));
      setQueues((current) => ({ ...current, [result.session.id]: current[result.session.id] || [] }));
      setInteractions((current) => ({ ...current, [result.session.id]: null }));
      setSelectedSessionId(result.session.id);
      setHistoryOpen(false);
      setDrawerOpen(false);
      forkSessionIdsRef.current.delete(forkKey);
      window.setTimeout(() => void loadSession(result.session.id), 150);
      if (result.warning) setError(result.warning);
    } catch {
      // Keep the stable clientSessionId so a manual retry cannot duplicate the fork.
    } finally {
      setForkingMessageId(null);
    }
  }, [forkingMessageId, loadSession, runCommand, selected]);

  const sendMessage = useCallback(async () => {
    const composerText = composer || composerComposition;
    if (
      !selectedSessionId ||
      (!composerDocumentHasContent(composerDocument) && pendingImages.length === 0 && !pendingAction)
    ) return;
    const content = composerText.trim() || (pendingImages.length > 0 ? "请查看附件图片。" : "");
    const action = pendingAction;
    const config = configs[selectedSessionId];
    const clientMessageId = createClientId();
    const optimisticImages = pendingImages.map(({ id, name, preview }) => ({ id, name, src: preview }));
    const optimisticReferences = selectedReferenceSessions.map((session) => ({
      sourceSessionId: session.id,
      sourceTitle: session.title,
    }));
    try {
      let queued = false;
      if (!demoMode) {
        const result = await runCommand<{ queued?: boolean }>("session.send", {
          sessionId: selectedSessionId,
          clientMessageId,
          content,
          planModeEnabled: config?.planModeEnabled === true,
          permissionMode: config?.permissionMode || "auto",
          images: pendingImages.map(({ preview: _preview, ...image }) => image),
          sessionReferences: optimisticReferences.map(({ sourceSessionId }) => ({ sourceSessionId })),
          composerDocument: remoteComposerDocument(composerDocument),
          action,
        });
        queued = result.queued === true;
      }
      followMessageBottomRef.current = false;
      returningToBottomRef.current = false;
      if (!queued) {
        setMessages((current) => {
          const sessionMessages = current[selectedSessionId] || [];
          if (sessionMessages.some((message) => message.id === clientMessageId)) return current;
          return {
            ...current,
            [selectedSessionId]: [
              ...sessionMessages,
              {
                id: clientMessageId,
                role: "user",
                content,
                timestamp: Date.now(),
                images: optimisticImages.length > 0 ? optimisticImages : undefined,
                sessionReferences: optimisticReferences.length > 0 ? optimisticReferences : undefined,
                action,
                composerDocument: remoteComposerDocument(composerDocument),
              },
            ],
          };
        });
      }
      replaceComposer("");
      setPendingImages([]);
      setPendingReferenceIds([]);
      setPendingAction(undefined);
      draftValueRef.current = { text: "", referenceSessionIds: [] };
      draftUserEditedRef.current = false;
      if (!demoMode && activeHost) {
        void clearSessionDraft(activeHost.hostId, selectedSessionId)
          .catch((error) => console.error("[mobile-draft] clear failed", error));
      }
      if (!queued) requestAnimationFrame(returnToMessageBottom);
    } catch {
      // The command error remains visible; sends are never retried automatically.
    }
  }, [activeHost, composer, composerComposition, composerDocument, configs, demoMode, pendingAction, pendingImages, replaceComposer, returnToMessageBottom, runCommand, selectedReferenceSessions, selectedSessionId]);

  const submitInteraction = useCallback(async (answers: unknown[], text: string, cancelled = false, confirmed?: boolean) => {
    if (!selectedSessionId || !selectedInteraction) return;
    const normalizedInteractionMethod = selectedInteraction.method?.toLowerCase() || "";
    const isConfirmation = normalizedInteractionMethod === "confirm";
    const isPermissionChoice = !isConfirmation && normalizedInteractionMethod.includes("permission");
    if (demoMode) {
      setInteractions((current) => ({ ...current, [selectedSessionId]: null }));
      if (!cancelled && !isConfirmation && !isPermissionChoice) {
        followMessageBottomRef.current = false;
        returningToBottomRef.current = false;
        setMessages((current) => ({
          ...current,
          [selectedSessionId]: [
            ...(current[selectedSessionId] || []),
            {
              id: createClientId(),
              role: "user",
              content: text || "已提交问卷回答",
              timestamp: Date.now(),
            },
          ],
        }));
        requestAnimationFrame(returnToMessageBottom);
      }
      return;
    }
    try {
      await runCommand("interaction.respond", {
        sessionId: selectedSessionId,
        requestId: selectedInteraction.requestId,
        method: selectedInteraction.method,
        cancelled,
        confirmed,
        text,
        answers,
      });
      setInteractions((current) => ({ ...current, [selectedSessionId]: null }));
    } catch {
      // runCommand keeps the interaction and error visible so the user can retry.
    }
  }, [demoMode, returnToMessageBottom, runCommand, selectedInteraction, selectedSessionId]);

  const addImage = useCallback(async () => {
    if (pendingImages.length >= MAX_REMOTE_IMAGES) return;
    try {
      const image = await chooseRemoteImage();
      setPendingImages((current) => [...current, image]);
    } catch (err) {
      if (!isImageSelectionCancelled(err)) setError(getImageErrorMessage(err));
    }
  }, [pendingImages.length]);

  const toggleComposerReference = useCallback((session: RemoteSession) => {
    const selectedReference = pendingReferenceIds.includes(session.id);
    if (selectedReference) {
      updateComposerDocument(createComposerDocument(composerDocument.nodes.filter((node) =>
        node.type !== "session" || node.reference.sourceSessionId !== session.id
      )));
      return;
    }
    if (pendingReferenceIds.length >= MAX_REMOTE_SESSION_REFERENCES) return;
    inlineComposerRef.current?.insertNode({
      id: createClientId(),
      type: "session",
      reference: {
        sourceSessionId: session.id,
        sourceTitle: session.title,
        sourceAgentId: session.agentId,
      },
    });
  }, [composerDocument, pendingReferenceIds, updateComposerDocument]);

  const updateHostDetails = async (host: PairedHost, form: HTMLFormElement) => {
    if (savingHostId === host.id) return;
    setSavingHostId(host.id);
    setError("");
    try {
      const formData = new FormData(form);
      const alias = String(formData.get("alias") ?? editingHostAlias);
      const note = String(formData.get("note") ?? editingHostNote);
      const address = String(formData.get("baseUrl") ?? editingAddress);
      const nextHost = withPairedHostMetadata(withPreferredHostBaseUrl(host, address), alias, note);
      const next = hosts.map((item) => item.id === host.id ? nextHost : item);
      await savePairedHosts(next);
      setHosts(next);
      setEditingHostId(null);
      showFloatingToast("桌面信息已保存");
      if (activeHost?.id === host.id) connectHost(nextHost);
    } catch (err) {
      setError(`保存桌面信息失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingHostId(null);
    }
  };

  const updateDialog = (
    <AndroidUpdateDialog
      open={updateDialogOpen}
      currentVersion={appVersion}
      metadata={updateMetadata}
      stage={updateStage}
      progress={updateProgress}
      error={updateError}
      onClose={closeUpdateDialog}
      onPrimary={handleUpdatePrimary}
    />
  );

  if (!hostsLoaded) {
    return <div className="boot-screen"><LoaderCircle className="spin" size={28} /><span>正在打开 Hpp</span></div>;
  }

  if (!activeHost) {
    return (
      <main
        ref={connectionsScreenRef}
        className="connections-screen"
        onTouchStart={handleHostPullStart}
        onTouchMove={handleHostPullMove}
        onTouchEnd={handleHostPullEnd}
        onTouchCancel={handleHostPullEnd}
      >
        <div
          className={`connections-pull-refresh ${hostPullDistance > 0 || refreshingHosts ? "visible" : ""}`}
          style={{ height: refreshingHosts ? 36 : Math.min(36, hostPullDistance) }}
          aria-live="polite"
        >
          <RefreshCw className={refreshingHosts ? "spin" : undefined} size={15} />
          <span>{refreshingHosts ? "刷新中" : hostPullDistance >= 52 ? "松开刷新" : "下拉刷新"}</span>
        </div>
        <header className="connections-header">
          <div className="brand-mark"><Smartphone size={22} /></div>
          <div><h1>Hpp</h1><p>选择一台已配对的桌面</p></div>
          <button type="button" className="icon-button" onClick={() => setPairingMode("manual")} title="添加桌面"><Plus size={20} /></button>
        </header>
        {floatingToast && (
          <div key={floatingToast.id} className="mobile-floating-toast" role="status" aria-live="polite">
            {floatingToast.text}
          </div>
        )}
        {error && <div className="app-error"><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}
        <section className="host-list">
          {hosts.map((host) => {
            const availability = hostAvailability[host.id] || "checking";
            return (
              <article className="host-row" key={host.id}>
                <button
                  type="button"
                  className={`host-connect ${availability !== "online" ? "unavailable" : ""}`}
                  aria-disabled={availability !== "online"}
                  onClick={() => openSavedHost(host, availability)}
                >
                  <span className="host-icon"><FolderGit2 size={19} /></span>
                  <span>
                    <strong>{host.alias || host.hostName}</strong>
                    <small>{host.note ? `${host.note} · ${host.baseUrl}` : host.baseUrl}</small>
                  </span>
                  <span className={`host-availability ${availability}`} title={`桌面${hostAvailabilityLabel(availability)}`}>
                    <span className="host-availability-dot" />
                    <span className="host-availability-label">{hostAvailabilityLabel(availability)}</span>
                  </span>
                  <ArrowLeft className="host-arrow" size={18} />
                </button>
                <button
                  ref={editingHostId === host.id ? editingHostTriggerRef : undefined}
                  type="button"
                  className="icon-button"
                  onClick={() => {
                    setEditingHostId(host.id);
                    setEditingHostAlias(host.alias || "");
                    setEditingHostNote(host.note || "");
                    setEditingAddress(host.baseUrl);
                  }}
                  title="编辑桌面"
                >
                  <MoreVertical size={18} />
                </button>
                {editingHostId === host.id && (
                  <form
                    ref={editingHostFormRef}
                    className="host-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void updateHostDetails(host, event.currentTarget);
                    }}
                  >
                    <div className="host-edit-fields">
                      <label>
                        <span>名称</span>
                        <input name="alias" value={editingHostAlias} onChange={(event) => setEditingHostAlias(event.target.value)} placeholder={host.hostName} maxLength={80} />
                      </label>
                      <label>
                        <span>备注</span>
                        <input name="note" value={editingHostNote} onChange={(event) => setEditingHostNote(event.target.value)} placeholder="例如：办公室电脑" maxLength={200} />
                      </label>
                      <label>
                        <span>连接地址</span>
                        <input name="baseUrl" value={editingAddress} onChange={(event) => setEditingAddress(event.target.value)} />
                      </label>
                    </div>
                    <div className="host-edit-actions">
                      <button type="submit" disabled={savingHostId === host.id}>
                        {savingHostId === host.id && <LoaderCircle className="spin" size={15} />}
                        {savingHostId === host.id ? "保存中" : "保存"}
                      </button>
                      <button type="button" className="danger" disabled={savingHostId === host.id} onClick={() => void updateHosts(hosts.filter((item) => item.id !== host.id))} title="删除配对"><Trash2 size={15} /></button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
          {hosts.length === 0 && (
            <div className="empty-hosts"><Link2 size={28} /><strong>尚未配对桌面</strong></div>
          )}
        </section>
        <div className={`pair-actions ${IS_NATIVE_APP ? "native" : "web"}`}>
          {IS_NATIVE_APP ? (
            <>
              <button type="button" className="primary-command" onClick={() => void scanPairing()} disabled={pairingBusy}>
                {pairingBusy ? <LoaderCircle className="spin" size={18} /> : <QrCode size={18} />} 扫描配对二维码
              </button>
              <button type="button" className="secondary-command" onClick={() => setPairingMode("manual")}><Link2 size={18} /> 输入配对链接</button>
            </>
          ) : (
            <button type="button" className="primary-command" onClick={() => setPairingMode("manual")}><Link2 size={18} /> 输入配对链接</button>
          )}
        </div>
        <footer className="connections-footer">
          {IS_NATIVE_APP ? (
            <button
              type="button"
              className="app-version-button"
              disabled={updateStage === "checking"}
              onClick={() => void checkAndroidUpdate(true)}
              title="检查 Android 更新"
            >
              <RefreshCw className={updateStage === "checking" ? "spin" : undefined} size={12} />
              <span>Hpp v{appVersion}</span>
              {updateMetadata && updateStage !== "up-to-date" && <small>有更新</small>}
            </button>
          ) : (
            <span className="app-version-label">Hpp v{appVersion}</span>
          )}
        </footer>
        {pairingMode === "manual" && (
          <div className="sheet-backdrop" onClick={() => setPairingMode("closed")}>
            <section className="bottom-sheet" onClick={(event) => event.stopPropagation()}>
              <div className="sheet-handle" />
              <div className="sheet-title"><h2>配对桌面</h2><button className="icon-button" onClick={() => setPairingMode("closed")}><X size={19} /></button></div>
              <textarea rows={4} value={pairingLink} onChange={(event) => setPairingLink(event.target.value)} placeholder="粘贴 Hpp 配对链接" />
              <button className="primary-command" disabled={pairingBusy || !pairingLink.trim()} onClick={() => void pairFromLink(pairingLink)}>
                {pairingBusy ? <LoaderCircle className="spin" size={18} /> : <Link2 size={18} />} 配对
              </button>
            </section>
          </div>
        )}
        {updateDialog}
      </main>
    );
  }

  return (
    <main className="workspace-screen">
      <header className="mobile-toolbar">
        <button className="icon-button mobile-menu" onClick={() => setDrawerOpen(true)}><Menu size={20} /></button>
        <div className="toolbar-context">
          <div className="toolbar-title-row">
            <strong>{selected?.session.title || activeHost.alias || activeHost.hostName}</strong>
            {selected?.session.status === "running" && <SessionRunningIndicator />}
          </div>
          <div className="toolbar-subtitle">
            <small>{selected ? `${selected.project.name} · ${selected.session.agentId}` : activeHost.baseUrl}</small>
            {selected && (
              <button
                type="button"
                className="toolbar-reload-button"
                disabled={!isConnected || commandBusy || reloadingSession}
                onClick={() => setReloadConfirmOpen(true)}
                title={`重载 ${selectedAgent?.name || selected.session.agentId}`}
                aria-label={`重载 ${selectedAgent?.name || selected.session.agentId}`}
              >
                <RefreshCw className={reloadingSession ? "spin" : undefined} size={11} strokeWidth={2} />
              </button>
            )}
            {selected && (
              <button type="button" className="toolbar-history-button" onClick={() => setHistoryOpen(true)} title="发言记录" aria-label="发言记录">
                <MessageCircle size={14} />
              </button>
            )}
          </div>
          <span className={`toolbar-connection ${connectionState}`} title={connectionLabel(connectionState)} aria-label={connectionLabel(connectionState)}>
            {isConnected
              ? <Wifi size={14} />
              : connectionState === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
          </span>
        </div>
      </header>

      {updateDialog}

      {editingQueueItem && selected && (
        <QueueEditDialog
          key={`${selected.session.id}:${editingQueueItem.id}`}
          item={editingQueueItem}
          referenceCandidates={referenceCandidates}
          onClose={() => setEditingQueueItem(null)}
          onSave={saveQueuedMessage}
        />
      )}

      {reloadConfirmOpen && selected && (
        <div className="sheet-backdrop session-reload-backdrop" onClick={() => { if (!reloadingSession) setReloadConfirmOpen(false); }}>
          <section
            className="bottom-sheet session-reload-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-reload-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-title">
              <div>
                <h2 id="session-reload-title">重载 {selectedAgent?.name || selected.session.agentId}</h2>
                <p>{selected.session.title}</p>
              </div>
              <button className="icon-button" disabled={reloadingSession} onClick={() => setReloadConfirmOpen(false)} title="关闭"><X size={19} /></button>
            </div>
            <p className="session-reload-description">是否重载当前会话？会重新打开 Agent，并继续使用当前会话记录。</p>
            {selected.session.status === "running" && (
              <div className="session-reload-warning">当前会话正在运行，请等待任务结束后再重载。</div>
            )}
            <div className="session-reload-actions">
              <button type="button" className="secondary-command" disabled={reloadingSession} onClick={() => setReloadConfirmOpen(false)}>取消</button>
              <button
                type="button"
                className="primary-command"
                disabled={reloadingSession || selected.session.status === "running"}
                onClick={() => void reloadCurrentSession()}
              >
                {reloadingSession ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                {reloadingSession ? "重载中" : "确认重载"}
              </button>
            </div>
          </section>
        </div>
      )}

      {error && <div className="app-error workspace-error"><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}
      {floatingToast && (
        <div key={floatingToast.id} className="mobile-floating-toast" role="status" aria-live="polite">
          {floatingToast.text}
        </div>
      )}

      <aside className={`project-drawer ${drawerOpen ? "open" : ""}`}>
        <div className="drawer-host">
          <div>
            <strong>{activeHost.alias || activeHost.hostName}</strong>
            <span className={connectionState}>{connectionLabel(connectionState)} · {activeHost.baseUrl}</span>
          </div>
          <button className="icon-button" onClick={() => { clientRef.current?.disconnect(); activeHostRef.current = null; setActiveHost(null); }} title="返回主机列表"><ArrowLeft size={18} /></button>
        </div>
        <div className="drawer-header">
          <div><strong>Projects</strong><span>{projects.length}</span></div>
          <button className="icon-button" onClick={() => setDrawerOpen(false)}><X size={19} /></button>
        </div>
        <nav className="project-list">
          {projects.map((project) => {
            const openSessions = project.sessions.filter((session) => !session.closed);
            const closedSessions = project.sessions
              .filter((session) => session.closed)
              .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt));
            return (
              <details key={project.id} open>
                <summary className="project-summary">
                  <FolderGit2 size={15} />
                  <span>{project.name}</span>
                  <span className="project-summary-actions" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
                    <button
                      type="button"
                      className="project-quick-action create"
                      aria-disabled={!isConnected || agents.length === 0}
                      onClick={() => {
                        if (isConnected && agents.length > 0) openSessionCreator(project);
                      }}
                      title="新建会话"
                      aria-label={`新建会话：${project.name}`}
                    >
                      <Plus size={15} />
                    </button>
                    <button
                      type="button"
                      className={`project-quick-action history ${historyProjectId === project.id ? "active" : ""}`}
                      aria-disabled={closedSessions.length === 0}
                      aria-pressed={historyProjectId === project.id}
                      onClick={() => {
                        if (closedSessions.length === 0) return;
                        setHistoryProjectId(project.id);
                      }}
                      title="历史会话"
                      aria-label={`历史会话：${project.name}`}
                    >
                      <History size={14} />
                      {closedSessions.length > 0 && <small>{closedSessions.length}</small>}
                    </button>
                  </span>
                  <ChevronDown size={14} />
                </summary>
                <div className="session-list">
                  {openSessions.map((session) => (
                    <div className={`session-row ${selectedSessionId === session.id ? "active" : ""}`} key={session.id}>
                      <button className={`session-main ${session.status === "running" ? "has-running" : ""}`} onClick={() => selectSession(session.id)}>
                        <span className={`session-state ${session.status}`} />
                        <span><strong>{session.title}</strong><small>{session.agentId} · {session.status}</small></span>
                        {session.status === "running" && <SessionRunningIndicator />}
                      </button>
                      <button
                        type="button"
                        className="session-action close"
                        disabled={commandBusy}
                        onClick={() => void closeRemoteSession(project, session)}
                        title="关闭会话"
                        aria-label={`关闭会话：${session.title}`}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
          {projects.length === 0 && <div className="drawer-empty">{isConnected ? "桌面尚未添加项目" : "等待桌面连接"}</div>}
        </nav>
      </aside>
      {drawerOpen && <button className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-label="关闭项目列表" />}

      {historyProject && (
        <div className="sheet-backdrop" onClick={() => { if (!commandBusy) setHistoryProjectId(null); }}>
          <section className="bottom-sheet project-history-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-title">
              <div><h2>历史会话</h2><p>{historyProject.name} · {historyProjectSessions.length} 个会话</p></div>
              <button className="icon-button" disabled={commandBusy} onClick={() => setHistoryProjectId(null)}><X size={19} /></button>
            </div>
            <div className="project-history-list">
              {historyProjectSessions.map((session) => (
                <div className="project-history-row" key={session.id}>
                  <span className="session-state archived" />
                  <span className="project-history-main">
                    <strong>{session.title}</strong>
                    <small>{session.agentId} · {formatHistoryMessageTime(Date.parse(session.lastActiveAt))}</small>
                  </span>
                  <button
                    type="button"
                    className="project-history-restore"
                    disabled={commandBusy}
                    onClick={() => void reopenRemoteSession(historyProject, session)}
                    title="恢复会话"
                    aria-label={`恢复会话：${session.title}`}
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
              ))}
              {historyProjectSessions.length === 0 && <div className="history-empty">暂无历史会话</div>}
            </div>
          </section>
        </div>
      )}

      {createProject && (
        <div className="sheet-backdrop" onClick={() => { if (!commandBusy) setCreateProject(null); }}>
          <section className="bottom-sheet create-session-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-title">
              <div><h2>新建会话</h2><p>{createProject.name}</p></div>
              <button className="icon-button" disabled={commandBusy} onClick={() => setCreateProject(null)}><X size={19} /></button>
            </div>
            <div className="agent-picker-list">
              {agents.map((agent) => (
                <button
                  type="button"
                  className={createAgentId === agent.id ? "selected" : ""}
                  aria-pressed={createAgentId === agent.id}
                  key={agent.id}
                  disabled={commandBusy}
                  onClick={() => setCreateAgentId(agent.id)}
                >
                  <span className="agent-picker-icon"><Bot size={17} /></span>
                  <span><strong>{agent.name}</strong><small>{agent.description || agent.id}</small></span>
                  <span className="agent-picker-radio" />
                </button>
              ))}
              {agents.length === 0 && <div className="agent-picker-empty">桌面没有可用的 Agent</div>}
            </div>
            <button className="primary-command" disabled={commandBusy || !createAgentId} onClick={() => void createRemoteSession()}>
              {commandBusy ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />} 创建会话
            </button>
          </section>
        </div>
      )}

      {historyOpen && selected && (
        <div className="sheet-backdrop" onClick={() => setHistoryOpen(false)}>
          <section className="bottom-sheet history-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-title">
              <div><h2>发言记录</h2><p>{selected.session.title}</p></div>
              <button className="icon-button" onClick={() => setHistoryOpen(false)}><X size={19} /></button>
            </div>
            <div className="history-list">
              {selectedUserMessages.map((message, index) => (
                <button type="button" className="history-item" key={message.id} onClick={() => openHistoryMessage(message.id)}>
                  <span>{message.content ? renderAttachmentPreview(message.content) : "图片消息"}</span>
                  <div className="history-item-meta">
                    <time>{formatHistoryMessageTime(message.timestamp)}</time>
                    {index === 0 && selected.session.status === "running" && <SessionRunningIndicator />}
                  </div>
                </button>
              ))}
              {selectedUserMessages.length === 0 && <div className="history-empty">暂无发言</div>}
              {nextBefore[selected.session.id] !== null && nextBefore[selected.session.id] !== undefined && (
                <button className="history-load-older" disabled={loadingSession} onClick={() => void loadSession(selected.session.id, false, nextBefore[selected.session.id])}>
                  {loadingSession ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 加载更早发言
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {referenceSheetOpen && selected && (
        <div className="sheet-backdrop" onClick={() => setReferenceSheetOpen(false)}>
          <section className="bottom-sheet reference-session-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-title">
              <div><h2>引用会话</h2><p>{selected.project.name}</p></div>
              <button className="icon-button" onClick={() => setReferenceSheetOpen(false)} title="关闭"><X size={19} /></button>
            </div>
            <div className="reference-session-list">
              {referenceCandidates.length === 0 ? (
                <div className="reference-session-empty">没有其他可引用会话</div>
              ) : referenceCandidates.map((session) => {
                const selectedReference = pendingReferenceIds.includes(session.id);
                return (
                  <button
                    type="button"
                    className={`reference-session-row ${selectedReference ? "selected" : ""}`}
                    key={session.id}
                    disabled={pendingReferenceIds.length >= MAX_REMOTE_SESSION_REFERENCES && !selectedReference}
                    onClick={() => toggleComposerReference(session)}
                  >
                    {selectedReference ? <Check size={15} /> : <Plus size={15} />}
                    <span><strong>{renderAttachmentPreview(session.title)}</strong><small>{agents.find((agent) => agent.id === session.agentId)?.name || session.agentId}{session.closed ? " · 已关闭" : ""}</small></span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {actionSheetOpen && selected && selectedAgent?.supportsActions === true && (
        <AgentActionSheet
          key={selected.session.id}
          agentId={selected.session.agentId}
          actions={actionCatalog}
          selectedAction={pendingAction}
          loading={actionLoading}
          error={actionError}
          onClose={() => setActionSheetOpen(false)}
          onRefresh={() => void loadAgentActions(true)}
          onSelect={selectAgentAction}
        />
      )}

      {!selected ? (
        <section className="session-picker-view">
          <header className="session-picker-header">
            <div><MessageSquare size={20} /><strong>选择会话</strong></div>
            <span>{openSessionCount}</span>
          </header>
          <div className="session-picker-projects">
            {projects.map((project) => {
              const openSessions = project.sessions.filter((session) => !session.closed);
              if (openSessions.length === 0) return null;
              return (
                <section className="session-picker-project" key={project.id}>
                  <div className="session-picker-project-title">
                    <FolderGit2 size={15} />
                    <strong>{project.name}</strong>
                    <span>{openSessions.length}</span>
                  </div>
                  <div className="session-picker-list">
                    {openSessions.map((session) => (
                      <button
                        type="button"
                        className={`session-picker-row ${session.status === "running" ? "has-running" : ""}`}
                        key={session.id}
                        onClick={() => selectSession(session.id)}
                      >
                        <span className={`session-state ${session.status}`} />
                        <span className="session-picker-copy">
                          <strong>{session.title}</strong>
                          <small>{agents.find((agent) => agent.id === session.agentId)?.name || session.agentId}</small>
                        </span>
                        {session.status === "running" && <SessionRunningIndicator />}
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
            {openSessionCount === 0 && (
              <div className="session-picker-empty"><MessageSquare size={28} /><strong>暂无打开的会话</strong></div>
            )}
          </div>
        </section>
      ) : (
        <section className="chat-view">
          <div className="messages-shell">
            <div
              ref={messagesViewRef}
              className="messages-view"
              onScroll={handleMessagesScroll}
              onPointerDown={cancelReturnToBottom}
              onWheel={cancelReturnToBottom}
            >
              {nextBefore[selected.session.id] !== null && nextBefore[selected.session.id] !== undefined && (
                <button className="load-older" disabled={loadingSession} onClick={() => void loadSession(selected.session.id, false, nextBefore[selected.session.id])}>
                  {loadingSession ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} 更早消息
                </button>
              )}
              <MessageListView
                messages={selectedMessages}
                receivedUserMessages={receivedUserMessages}
                activeTurnMessageId={activeTurnMessageId}
                processTerminalState={processTerminalState}
                actionsDisabled={commandBusy || forkingMessageId !== null}
                forkingMessageId={forkingMessageId}
                onEdit={editMessage}
                onCopy={copyMessage}
                onFork={forkMessage}
              />
              {loadingSession && selectedMessages.length === 0 && <div className="loading-chat"><LoaderCircle className="spin" size={22} /></div>}
            </div>
            {showReturnToBottom && (
              <button
                type="button"
                className="return-bottom-button"
                onClick={returnToMessageBottom}
                title="返回底部"
                aria-label="返回底部"
              >
                <ArrowDown size={18} />
              </button>
            )}
          </div>

          {selectedQueue.length > 0 && (
            <QueuePanel
              items={selectedQueue}
              disabled={commandBusy}
              canGuide={selectedAgent?.supportsGuidance === true}
              currentSessionRunning={selected.session.status === "running"}
              onEdit={setEditingQueueItem}
              onGuide={(item) => void guideQueuedMessage(item)}
              onReorder={(itemId, toIndex) => void reorderQueuedMessage(itemId, toIndex)}
              onRemove={(item) => void removeQueuedMessage(item)}
            />
          )}

          {selectedInteraction && (
            selectedInteraction.method?.toLowerCase() === "confirm"
              ? <Confirmation
                  key={`${selected.session.id}:${selectedInteraction.requestId || "confirm"}`}
                  interaction={selectedInteraction}
                  disabled={commandBusy}
                  onRespond={(confirmed) => void submitInteraction([], confirmed ? "允许" : "拒绝", false, confirmed)}
                />
              : selectedInteraction.method?.toLowerCase().includes("permission")
                ? <PermissionChoice
                    key={`${selected.session.id}:${selectedInteraction.requestId || "permission"}`}
                    interaction={selectedInteraction}
                    disabled={commandBusy}
                    onRespond={(answers, value) => void submitInteraction(answers, value)}
                  />
              : <Questionnaire
                  key={`${selected.session.id}:${selectedInteraction.requestId || selectedInteraction.questions.map((question) => question.question).join("|")}`}
                  interaction={selectedInteraction}
                  disabled={commandBusy}
                  onSubmit={(answers, text, cancelled) => void submitInteraction(answers, text, cancelled)}
                />
          )}

          <footer className="composer">
            {pendingAction && (
              <div className="composer-preview-bar">
                {pendingAction && (
                  <div className="composer-preview-chip action">
                    <WandSparkles size={12} />
                    <span>{pendingAction.kind === "skill" ? "技能" : "命令"} · {pendingAction.name}</span>
                    <button type="button" onClick={clearAgentAction} title="移除技能或命令" aria-label="移除技能或命令"><X size={12} /></button>
                  </div>
                )}
              </div>
            )}
            <div className="composer-input-shell">
              {pendingImages.length > 0 && (
                <div className="composer-image-previews">
                  {pendingImages.map((image) => (
                    <div className="composer-image-preview" key={image.id}>
                      <img src={image.preview} alt={image.name} />
                      <button type="button" onClick={() => setPendingImages((current) => current.filter((item) => item.id !== image.id))} title="移除图片" aria-label="移除图片"><X size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div ref={composerAddMenuRef} className="composer-add-control">
                <button
                  type="button"
                  className="composer-inline-button"
                  disabled={!isConnected}
                  aria-haspopup="menu"
                  aria-expanded={composerAddMenuOpen}
                  onClick={() => setComposerAddMenuOpen((open) => !open)}
                  title="添加内容"
                >
                  <Plus size={19} />
                </button>
                {composerAddMenuOpen && (
                  <div className="composer-add-menu" role="menu">
                    <button type="button" role="menuitem" disabled={pendingImages.length >= MAX_REMOTE_IMAGES} onClick={() => { setComposerAddMenuOpen(false); void addImage(); }}>
                      <Camera size={15} /><span>图片</span>
                    </button>
                    <button type="button" role="menuitem" disabled={referenceCandidates.length === 0} onClick={() => { setComposerAddMenuOpen(false); setReferenceSheetOpen(true); }}>
                      <Link2 size={15} /><span>会话</span>
                    </button>
                    {selectedAgent?.supportsActions === true && (
                      <button type="button" role="menuitem" onClick={openActionSheet}>
                        <WandSparkles size={15} /><span>技能</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <InlineComposerEditor
                ref={inlineComposerRef}
                value={composerDocument}
                onChange={handleComposerChange}
                onCompositionStart={handleComposerCompositionStartInline}
                onCompositionEnd={handleComposerCompositionEndInline}
                placeholder={isConnected ? "发送指令" : "桌面未连接"}
                disabled={!isConnected}
              />
              <button
                className={`send-button ${showAbortButton ? "abort" : queueSend ? "queue" : composerAction === "none" ? "empty" : ""}`}
                disabled={!isConnected || commandBusy}
                onClick={() => {
                  const action = getComposerAction({
                    text: composer,
                    composingText: composerComposition,
                    imageCount: pendingImages.length,
                    referenceCount: selectedReferenceSessions.length,
                    actionCount: pendingAction ? 1 : 0,
                    running: selected.session.status === "running",
                  });
                  if (action === "abort") {
                    void runCommand("session.abort", { sessionId: selected.session.id });
                  } else if (action === "send") {
                    void sendMessage();
                  }
                }}
                title={showAbortButton ? "中止任务" : queueSend ? "加入队列" : "发送"}
              >
                {commandBusy
                  ? <LoaderCircle className="spin" size={18} />
                  : showAbortButton ? <Square size={14} fill="currentColor" strokeWidth={0} /> : <ArrowUp size={18} strokeWidth={2.5} />}
              </button>
            </div>
            <div className="composer-settings">
              {selectedReferenceSessions.length > 0 && (
                <button
                  type="button"
                  className="reference-toggle"
                  onClick={() => setReferenceSheetOpen(true)}
                  title="管理引用会话"
                  aria-label={`管理 ${selectedReferenceSessions.length} 个引用会话`}
                >
                  <Link2 size={14} />
                  <span>{selectedReferenceSessions.length}</span>
                </button>
              )}
              <button
                type="button"
                className={`plan-toggle ${selectedConfig?.planModeEnabled === true ? "active" : ""}`}
                aria-pressed={selectedConfig?.planModeEnabled === true}
                disabled={commandBusy}
                onClick={() => void runCommand<{ enabled: boolean }>("settings.setPlanMode", { enabled: selectedConfig?.planModeEnabled !== true }).then(({ enabled }) => setConfigs((current) => Object.fromEntries(Object.entries(current).map(([id, config]) => [id, { ...config, planModeEnabled: enabled }] ))))}
              >
                <ListChecks size={14} />
                <span>Plan</span>
              </button>
              {selectedAgent?.supportsPermissions === true && (
                <MobilePermissionPicker
                  value={selectedConfig?.permissionMode || "auto"}
                  disabled={commandBusy}
                  onSelect={(mode) => void runCommand<{ mode: AgentPermissionMode }>("settings.setPermissionMode", { mode }).then(({ mode: nextMode }) => setConfigs((current) => Object.fromEntries(Object.entries(current).map(([id, config]) => [id, { ...config, permissionMode: nextMode }] ))))}
                />
              )}
              <MobileModelPicker
                key={selected.session.id}
                agentName={selectedAgent?.name || selected.session.agentId}
                currentModel={selectedConfig?.model || null}
                models={selectedModels}
                disabled={commandBusy}
                onSelect={(model) => void switchModel(model)}
              />
              <MobileThinkingPicker
                value={selectedConfig?.thinkingLevel || "medium"}
                levels={thinkingLevels}
                disabled={commandBusy}
                onSelect={(level) => void runCommand<RemoteSessionConfig>("session.setThinking", { sessionId: selected.session.id, level }).then((config) => setConfigs((current) => ({ ...current, [selected.session.id]: config })))}
              />
            </div>
          </footer>
        </section>
      )}
    </main>
  );
}
