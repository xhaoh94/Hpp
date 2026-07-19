import {
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
} from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { BarcodeFormat, BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Bot,
  Camera,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  FolderGit2,
  GitBranch,
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
  Square,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type {
  RemoteCatalogSnapshot,
  RemoteAgent,
  RemoteChatMessage,
  RemoteInteraction,
  RemoteModel,
  RemoteProject,
  RemoteProcessEntry,
  RemoteQueuedMessage,
  RemoteSession,
  RemoteSessionConfig,
  RemoteSessionCreateResult,
} from "@shared/remote-protocol";
import { MAX_REMOTE_IMAGES, MAX_REMOTE_SESSION_REFERENCES } from "@shared/remote-protocol";
import { formatModelSwitchToastText } from "@shared/model-switch";
import {
  THINKING_LEVELS,
  getThinkingLevelLabel,
  groupModelsByProvider,
  includeCurrentModel,
} from "@shared/models";
import {
  getProcessGroupState,
  getVisibleProcessEntries,
  groupProcessEntries,
  splitCommandDetail,
} from "@shared/process-view";
import { buildDiffSummary, collectProcessDiffs, type ProcessDiffEntry } from "@shared/diff-summary";
import { areAssistantMessageActionsVisible, formatHistoryMessageTime } from "@shared/message-display";
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
  clearSessionDraft,
  loadLastPairedHostId,
  loadPairedHosts,
  loadSessionDraft,
  saveLastPairedHostId,
  savePairedHosts,
  saveSessionDraft,
  withPairedHostMetadata,
  type PairedHost,
} from "./storage";
import { copyText, createClientId } from "./web-platform";
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

type PairingMode = "closed" | "manual";
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
  availableModels: [
    { id: "gpt-5.6", name: "GPT-5.6", provider: "openai", reasoning: true, supportsImages: true },
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", reasoning: true, supportsImages: true },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "openrouter", reasoning: true, supportsImages: true },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "openrouter", reasoning: true, supportsImages: true },
  ],
};
const DEMO_AGENTS: RemoteAgent[] = [
  { id: "codex", name: "Codex", description: "OpenAI Codex agent", runtime: "cli", requiresProviderActivation: true, supportsGuidance: true },
  { id: "pi", name: "Pi", description: "Pi coding agent", runtime: "sdk", supportsGuidance: true },
  { id: "opencode", name: "OpenCode", description: "OpenCode agent", runtime: "cli" },
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
  const [open, setOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(currentModel?.provider || null);
  const modelsByProvider = useMemo(() => {
    return groupModelsByProvider(models);
  }, [models]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const providers = Array.from(modelsByProvider.keys());
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
      {open && (
        <div className="model-picker-menu" role="dialog" aria-label={`${agentName} 模型`}>
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
        </div>
      )}
    </div>
  );
}

function MobileThinkingPicker({
  value,
  disabled,
  onSelect,
}: {
  value: string;
  disabled: boolean;
  onSelect: (level: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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
        <span>{getThinkingLevelLabel(value)}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <div className="thinking-picker-menu" role="listbox" aria-label="鎬濊€冪瓑绾?">
          {THINKING_LEVELS.map((level) => (
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
        </div>
      )}
    </div>
  );
}

function ProcessEntryRow({ entry }: { entry: RemoteProcessEntry }) {
  const hasDetails = Boolean(entry.detail?.trim() || entry.files?.length);
  const row = (
    <>
      <span className={`entry-state ${entry.state || "completed"}`} />
      <span className="process-entry-title" title={entry.title}>{entry.title}</span>
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
      {entry.detail && <pre>{entry.detail}</pre>}
      {entry.files && entry.files.length > 0 && (
        <div className="process-files">
          {entry.files.map((file, index) => <code key={`${String(file.file)}-${index}`}>{String(file.file || "file")}</code>)}
        </div>
      )}
    </details>
  );
}

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

function MessageProcess({ message }: { message: RemoteChatMessage }) {
  const processStartedAt = message.process?.startedAt;
  const [expanded, setExpanded] = useState(message.isStreaming === true);
  const processStartedAtRef = useRef(processStartedAt);
  useEffect(() => {
    if (processStartedAt && processStartedAt !== processStartedAtRef.current) {
      processStartedAtRef.current = processStartedAt;
      setExpanded(message.isStreaming === true);
    }
  }, [message.isStreaming, processStartedAt]);
  if (!message.process) return null;
  const visibleEntries = getVisibleProcessEntries(message.process.entries);
  const hasPlan = !!message.process.planSteps?.length;
  if (!hasPlan && visibleEntries.length === 0 && !message.process.changeSummary) return null;
  return (
    <details className="process-block" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span>{message.process.endedAt ? "执行过程" : "正在执行"}</span>
        <span className="process-summary-meta">
          {message.process.changeSummary && (
            <small>
              {message.process.changeSummary.filesChanged} files · +{message.process.changeSummary.additions} -{message.process.changeSummary.deletions}
            </small>
          )}
          <ChevronDown className="expand-indicator" size={14} />
        </span>
      </summary>
      {hasPlan && (
        <div className="process-plan">
          {message.process.planSteps!.map((step) => (
            <div key={step.id} data-status={step.status}><span /><span className="process-plan-title">{step.title}</span></div>
          ))}
        </div>
      )}
      {visibleEntries.length > 0 && (
        <div className="process-entries">
          {groupProcessEntries(visibleEntries).map((group) => group.kind === "commands"
            ? <CommandGroup key={`commands-${group.entries[0].id}`} entries={group.entries} />
            : <ProcessEntryRow key={group.entry.id} entry={group.entry} />)}
        </div>
      )}
    </details>
  );
}

function MessageItem({
  message,
  actionsDisabled,
  forking,
  onEdit,
  onFork,
}: {
  message: RemoteChatMessage;
  actionsDisabled: boolean;
  forking: boolean;
  onEdit: (content: string) => void;
  onFork: (message: RemoteChatMessage) => void;
}) {
  const assistantActionsReady = areAssistantMessageActionsVisible(message);
  const diffSummary = buildDiffSummary([
    ...(message.diffs || []),
    ...collectProcessDiffs(message.process as unknown as { entries?: ProcessDiffEntry[] }),
  ]);
  const showActions = message.role === "user" || assistantActionsReady;
  return (
    <article id={`message-${message.id}`} className={`message ${message.role}`}>
      {message.role === "system" && (
        <div className="message-meta">
          <span>System</span>
          <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
      )}
      {message.images && message.images.length > 0 && (
        <div className="message-images">
          {message.images.map((image) => <img key={image.id} src={image.src} alt={image.name} />)}
        </div>
      )}
      {message.sessionReferences && message.sessionReferences.length > 0 && (
        <div className={`message-reference-list ${message.role}`} aria-label="引用会话">
          {message.sessionReferences.map((reference) => (
            <span className="message-reference-chip" key={reference.sourceSessionId}>
              <Link2 size={11} />
              <span>引用会话: {reference.sourceTitle}</span>
            </span>
          ))}
        </div>
      )}
      <MessageProcess message={message} />
      {message.content && (
        <div className="message-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{message.content}</ReactMarkdown>
        </div>
      )}
      {diffSummary.files.map((diff) => (
        <details className="diff-block" key={`${message.id}-${diff.file}`}>
          <summary>
            <code>{diff.file}</code>
            <span className="diff-summary-meta">
              <span className="diff-stats">+{diff.additions} -{diff.deletions}</span>
              <ChevronDown className="expand-indicator" size={14} />
            </span>
          </summary>
          <pre>{diff.patches.join("\n")}</pre>
        </details>
      ))}
      {showActions && (
        <div className={`message-actions ${message.role}`}>
          {message.role === "user" && (
            <button type="button" onClick={() => onEdit(message.content)} disabled={actionsDisabled || !message.content} title="编辑" aria-label="编辑">
              <Pencil size={15} />
            </button>
          )}
          <button type="button" onClick={() => void copyText(message.content)} disabled={!message.content} title="复制" aria-label="复制">
            <Copy size={15} />
          </button>
          {assistantActionsReady && (
            <button type="button" onClick={() => onFork(message)} disabled={actionsDisabled} title="从这里 Fork" aria-label="从这里 Fork">
              {forking ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

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
  const [interactions, setInteractions] = useState<Record<string, RemoteInteraction | null>>({});
  const [configs, setConfigs] = useState<Record<string, RemoteSessionConfig>>({});
  const [loadingSession, setLoadingSession] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [composer, setComposer] = useState("");
  const [composerComposition, setComposerComposition] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingRemoteImage[]>([]);
  const [pendingReferenceIds, setPendingReferenceIds] = useState<string[]>([]);
  const [composerAddMenuOpen, setComposerAddMenuOpen] = useState(false);
  const [referenceSheetOpen, setReferenceSheetOpen] = useState(false);
  const [pairingMode, setPairingMode] = useState<PairingMode>("closed");
  const [pairingLink, setPairingLink] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingHostAlias, setEditingHostAlias] = useState("");
  const [editingHostNote, setEditingHostNote] = useState("");
  const [editingAddress, setEditingAddress] = useState("");
  const [savingHostId, setSavingHostId] = useState<string | null>(null);
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
  const selectedSessionRef = useRef<string | null>(null);
  const projectsRef = useRef<RemoteProject[]>([]);
  const agentsRef = useRef<RemoteAgent[]>([]);
  const configsRef = useRef<Record<string, RemoteSessionConfig>>({});
  const revisionsRef = useRef<Record<string, number>>({});
  const hostEpochRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerAddMenuRef = useRef<HTMLDivElement | null>(null);
  const messagesViewRef = useRef<HTMLDivElement | null>(null);
  const followMessageBottomRef = useRef(true);
  const returningToBottomRef = useRef(false);
  const forkSessionIdsRef = useRef(new Map<string, string>());
  const floatingToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftIdentityRef = useRef<{ hostId: string; sessionId: string; key: string } | null>(null);
  const loadedDraftKeyRef = useRef<string | null>(null);
  const draftValueRef = useRef({ text: "", referenceSessionIds: [] as string[] });
  const autoConnectAttemptedRef = useRef(false);
  const updateMetadataRef = useRef<AndroidUpdateMetadata | null>(null);
  const updateCheckInFlightRef = useRef(false);
  const dismissedUpdateVersionRef = useRef<number | null>(null);
  const updateStageRef = useRef<AndroidUpdateStage>("idle");
  const updateInstallInFlightRef = useRef(false);
  const incomingWebPairingRef = useRef(
    !IS_NATIVE_APP ? new URLSearchParams(window.location.search).get("pair") : null,
  );

  selectedSessionRef.current = selectedSessionId;
  projectsRef.current = projects;
  agentsRef.current = agents;
  configsRef.current = configs;
  updateStageRef.current = updateStage;
  draftValueRef.current = { text: composer, referenceSessionIds: pendingReferenceIds };

  const flushCurrentDraft = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    const identity = draftIdentityRef.current;
    if (!identity || loadedDraftKeyRef.current !== identity.key) return;
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
      setSelectedSessionId(DEMO_SESSION_ID);
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
    setHosts(next);
    await savePairedHosts(next);
  }, []);

  const loadCatalog = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    const snapshot = await client.request<RemoteCatalogSnapshot>("catalog.get");
    hostEpochRef.current = snapshot.hostEpoch;
    setProjects(snapshot.projects);
    setAgents(snapshot.agents || []);
  }, []);

  const loadSession = useCallback(async (sessionId: string, replace = true, before?: number | null) => {
    const client = clientRef.current;
    if (!client) return;
    setLoadingSession(true);
    try {
      const page = await client.request<SessionPage>("session.get", {
        sessionId,
        ...(before !== undefined && before !== null ? { before } : {}),
        limit: 50,
      });
      revisionsRef.current[sessionId] = page.revision;
      setMessages((current) => ({
        ...current,
        [sessionId]: replace ? page.messages : [...page.messages, ...(current[sessionId] || [])],
      }));
      setNextBefore((current) => ({ ...current, [sessionId]: page.nextBefore }));
      setQueues((current) => ({ ...current, [sessionId]: page.queue || [] }));
      setInteractions((current) => ({ ...current, [sessionId]: page.interaction || null }));
      if (page.config) setConfigs((current) => ({ ...current, [sessionId]: page.config! }));
      if (replace) {
        void client.request<RemoteSessionConfig>("session.models.get", { sessionId }).then((config) => {
          setConfigs((current) => ({ ...current, [sessionId]: config }));
        }).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSession(false);
    }
  }, []);

  const handleRemoteEvent = useCallback((name: string, payload: unknown, revision?: number, hostEpoch?: string) => {
    if (hostEpochRef.current && hostEpoch && hostEpochRef.current !== hostEpoch) {
      hostEpochRef.current = hostEpoch;
      revisionsRef.current = {};
      setMessages({});
      void loadCatalog();
    }
    const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (name === "catalog.updated") {
      if (Array.isArray(data.projects)) setProjects(data.projects as RemoteProject[]);
      if (Array.isArray(data.agents)) setAgents(data.agents as RemoteAgent[]);
      return;
    }
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
    if (!sessionId) return;
    const previousRevision = revisionsRef.current[sessionId] || 0;
    if (revision && previousRevision && revision !== previousRevision + 1) {
      revisionsRef.current[sessionId] = revision;
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
      configsRef.current = { ...configsRef.current, [sessionId]: config };
      setConfigs((current) => ({ ...current, [sessionId]: config }));
      if (config.availableModels === undefined && selectedSessionRef.current === sessionId) {
        void clientRef.current?.request<RemoteSessionConfig>("session.models.get", { sessionId }).then((nextConfig) => {
          setConfigs((current) => ({ ...current, [sessionId]: nextConfig }));
        }).catch(() => undefined);
      }
    }
  }, [loadCatalog, loadSession, showFloatingToast]);

  const connectHost = useCallback((host: PairedHost) => {
    autoConnectAttemptedRef.current = true;
    setLastHostId(host.id);
    void saveLastPairedHostId(host.id).catch((err) => {
      setError(`无法记住此桌面：${err instanceof Error ? err.message : String(err)}`);
    });
    clientRef.current?.disconnect();
    setError("");
    setActiveHost(host);
    setProjects([]);
    setAgents([]);
    setSelectedSessionId(null);
    setHistoryOpen(false);
    setMessages({});
    const client = new RemoteClient(host);
    clientRef.current = client;
    client.onHostUpdated((nextHost) => {
      if (clientRef.current !== client) return;
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
      if (state === "connected") void loadCatalog(client).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    });
    client.onEvent(handleRemoteEvent);
    void client.connect();
  }, [handleRemoteEvent, loadCatalog]);

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
    if (demoMode || !hostsLoaded || activeHost || hosts.length === 0) return;
    let disposed = false;

    const probeSavedHosts = async (showChecking: boolean) => {
      if (showChecking) {
        setHostAvailability((current) => Object.fromEntries(
          hosts.map((host) => [host.id, current[host.id] || "checking"]),
        ));
      }
      const results = await Promise.all(hosts.map(async (host) => [
        host.id,
        await probeHostAvailability(host),
      ] as const));
      if (!disposed) setHostAvailability(Object.fromEntries(results));
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
  }, [activeHost, demoMode, hosts, hostsLoaded]);

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
    if (!messages[sessionId]) void loadSession(sessionId);
  }, [loadSession, messages]);

  const selected = useMemo(() => findSession(projects, selectedSessionId), [projects, selectedSessionId]);
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
  const selectedModels = useMemo(() => {
    return includeCurrentModel(selectedConfig?.availableModels || [], selectedConfig?.model);
  }, [selectedConfig]);
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
    running: selected?.session.status === "running",
  });
  const composerHasContent = composerAction === "send";
  const showAbortButton = composerAction === "abort";
  const queueSend = selected?.session.status === "running" && composerHasContent;

  const updateComposer = useCallback((value: string) => {
    draftValueRef.current = { ...draftValueRef.current, text: value };
    setComposer((current) => current === value ? current : value);
  }, []);

  const syncComposerFromElement = useCallback((textarea: HTMLTextAreaElement | null = composerRef.current) => {
    if (!textarea) return;
    updateComposer(textarea.value);
  }, [updateComposer]);

  const scheduleComposerSync = useCallback((textarea: HTMLTextAreaElement) => {
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
    updateComposer(value);
  }, [updateComposer]);

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
    setPendingImages([]);
    replaceComposer("");
    setPendingReferenceIds([]);
    draftValueRef.current = { text: "", referenceSessionIds: [] };
    loadedDraftKeyRef.current = null;

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
      const nextDraft = { text: draft?.text || "", referenceSessionIds };
      draftValueRef.current = nextDraft;
      replaceComposer(nextDraft.text);
      setPendingReferenceIds(nextDraft.referenceSessionIds);
      loadedDraftKeyRef.current = identity.key;
    }).catch((error) => console.error("[mobile-draft] load failed", error));
    return () => { cancelled = true; };
  }, [activeHost?.hostId, demoMode, flushCurrentDraft, replaceComposer, selectedSessionId]);

  useEffect(() => {
    const identity = draftIdentityRef.current;
    if (!identity || loadedDraftKeyRef.current !== identity.key) return;
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
  }, [composer, pendingReferenceIds]);

  useEffect(() => {
    const handlePageHide = () => flushCurrentDraft();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
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
    requestAnimationFrame(() => composerRef.current?.focus());
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
        if (fallback && !messages[fallback.id]) void loadSession(fallback.id);
      }
    } catch {
      // runCommand keeps the error visible on mobile.
    }
  }, [applySessionResult, commandBusy, demoMode, loadSession, messages, projects, runCommand, selectedSessionId, setDemoSessionClosed]);

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
    const composerText = composerRef.current?.value || composer || composerComposition;
    if (!selectedSessionId || (!composerText.trim() && pendingImages.length === 0 && selectedReferenceSessions.length === 0)) return;
    const content = composerText.trim() || (pendingImages.length > 0 ? "请查看附件图片。" : "");
    const config = configs[selectedSessionId];
    const clientMessageId = createClientId();
    const optimisticImages = pendingImages.map(({ id, name, preview }) => ({ id, name, src: preview }));
    const optimisticReferences = selectedReferenceSessions.map((session) => ({
      sourceSessionId: session.id,
      sourceTitle: session.title,
    }));
    try {
      if (!demoMode) {
        await runCommand("session.send", {
          sessionId: selectedSessionId,
          clientMessageId,
          content,
          planModeEnabled: config?.planModeEnabled === true,
          images: pendingImages.map(({ preview: _preview, ...image }) => image),
          sessionReferences: optimisticReferences.map(({ sourceSessionId }) => ({ sourceSessionId })),
        });
      }
      followMessageBottomRef.current = false;
      returningToBottomRef.current = false;
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
            },
          ],
        };
      });
      replaceComposer("");
      setPendingImages([]);
      setPendingReferenceIds([]);
      draftValueRef.current = { text: "", referenceSessionIds: [] };
      if (!demoMode && activeHost) {
        void clearSessionDraft(activeHost.hostId, selectedSessionId)
          .catch((error) => console.error("[mobile-draft] clear failed", error));
      }
      requestAnimationFrame(returnToMessageBottom);
    } catch {
      // The command error remains visible; sends are never retried automatically.
    }
  }, [activeHost, composer, composerComposition, configs, demoMode, pendingImages, replaceComposer, returnToMessageBottom, runCommand, selectedReferenceSessions, selectedSessionId]);

  const submitInteraction = useCallback(async (answers: unknown[], text: string, cancelled = false) => {
    if (!selectedSessionId || !selectedInteraction) return;
    if (demoMode) {
      setInteractions((current) => ({ ...current, [selectedSessionId]: null }));
      if (!cancelled) {
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
      setPendingImages((current) => [...current, image].slice(0, MAX_REMOTE_IMAGES));
    } catch (err) {
      if (!isImageSelectionCancelled(err)) setError(getImageErrorMessage(err));
    }
  }, [pendingImages.length]);

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
      <main className="connections-screen">
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
            {selected && (
              <button type="button" className="toolbar-history-button" onClick={() => setHistoryOpen(true)} title="发言记录" aria-label="发言记录">
                <MessageCircle size={15} />
              </button>
            )}
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
          </div>
          <span className={`toolbar-connection ${connectionState}`} title={connectionLabel(connectionState)} aria-label={connectionLabel(connectionState)}>
            {isConnected
              ? <Wifi size={14} />
              : connectionState === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
          </span>
        </div>
      </header>

      {updateDialog}

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
          <button className="icon-button" onClick={() => { clientRef.current?.disconnect(); setActiveHost(null); }} title="返回主机列表"><ArrowLeft size={18} /></button>
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
                      <button className="session-main" onClick={() => selectSession(session.id)}>
                        <span className={`session-state ${session.status}`} />
                        <span><strong>{session.title}</strong><small>{session.agentId} · {session.status}</small></span>
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
            {nextBefore[selected.session.id] !== null && nextBefore[selected.session.id] !== undefined && (
              <button className="history-load-older" disabled={loadingSession} onClick={() => void loadSession(selected.session.id, false, nextBefore[selected.session.id])}>
                {loadingSession ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 加载更早发言
              </button>
            )}
            <div className="history-list">
              {selectedUserMessages.map((message) => (
                <button type="button" className="history-item" key={message.id} onClick={() => openHistoryMessage(message.id)}>
                  <span>{message.content || "图片消息"}</span>
                  <time>{formatHistoryMessageTime(message.timestamp)}</time>
                </button>
              ))}
              {selectedUserMessages.length === 0 && <div className="history-empty">暂无发言</div>}
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
              <div className="reference-session-section-title">已引用</div>
              {selectedReferenceSessions.length === 0 ? (
                <div className="reference-session-empty">暂无引用</div>
              ) : selectedReferenceSessions.map((session) => (
                <div className="reference-session-row selected" key={session.id}>
                  <Link2 size={14} />
                  <span><strong>{session.title}</strong><small>{agents.find((agent) => agent.id === session.agentId)?.name || session.agentId}{session.closed ? " · 已关闭" : ""}</small></span>
                  <button type="button" onClick={() => setPendingReferenceIds((current) => current.filter((id) => id !== session.id))} title="移除引用"><X size={15} /></button>
                </div>
              ))}
              <div className="reference-session-section-title">可添加</div>
              {referenceCandidates.filter((session) => !pendingReferenceIds.includes(session.id)).length === 0 ? (
                <div className="reference-session-empty">没有其他可引用会话</div>
              ) : referenceCandidates.filter((session) => !pendingReferenceIds.includes(session.id)).map((session) => (
                <button
                  type="button"
                  className="reference-session-row add"
                  key={session.id}
                  disabled={pendingReferenceIds.length >= MAX_REMOTE_SESSION_REFERENCES}
                  onClick={() => setPendingReferenceIds((current) => current.includes(session.id) ? current : [...current, session.id].slice(0, MAX_REMOTE_SESSION_REFERENCES))}
                >
                  <Plus size={15} />
                  <span><strong>{session.title}</strong><small>{agents.find((agent) => agent.id === session.agentId)?.name || session.agentId}{session.closed ? " · 已关闭" : ""}</small></span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {!selected ? (
        <section className="empty-chat"><MessageSquare size={30} /><strong>选择一个会话</strong></section>
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
              {selectedMessages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  actionsDisabled={commandBusy || forkingMessageId !== null}
                  forking={forkingMessageId === message.id}
                  onEdit={editMessage}
                  onFork={(target) => void forkMessage(target)}
                />
              ))}
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
            <div className="queue-strip">
              <div className="queue-header">
                <span>发送队列</span>
                <small>{selectedQueue.length}</small>
              </div>
              <div className="queue-list">
                {selectedQueue.map((item, index) => (
                  <div className={`queue-item ${item.status}`} key={item.id}>
                    <span className="queue-index">{index + 1}</span>
                    <div className="queue-main">
                      <span>{item.displayContent || "空消息"}</span>
                      {item.error && <small>{item.error}</small>}
                    </div>
                    {selectedAgent?.supportsGuidance === true && (
                      <button
                        type="button"
                        className="queue-guide"
                        disabled={commandBusy || selected.session.status !== "running" || item.status === "sending"}
                        onClick={() => void guideQueuedMessage(item)}
                        title={selected.session.status === "running" ? "立即作为引导发送" : "Agent 运行中才能引导"}
                      >
                        {item.status === "sending" ? <LoaderCircle className="spin" size={13} /> : <CornerDownRight size={13} />}
                        <span>引导</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="queue-remove"
                      disabled={commandBusy || item.status === "sending"}
                      onClick={() => void removeQueuedMessage(item)}
                      title="移出队列"
                      aria-label="移出队列"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selectedInteraction && (
            <Questionnaire
              key={`${selected.session.id}:${selectedInteraction.requestId || selectedInteraction.questions.map((question) => question.question).join("|")}`}
              interaction={selectedInteraction}
              disabled={commandBusy}
              onSubmit={(answers, text, cancelled) => void submitInteraction(answers, text, cancelled)}
            />
          )}

          <footer className="composer">
            {(pendingImages.length > 0 || selectedReferenceSessions.length > 0) && (
              <div className="composer-preview-bar">
                {selectedReferenceSessions.map((session) => (
                  <div className="composer-preview-chip reference" key={session.id}>
                    <Link2 size={12} />
                    <span>{session.title}</span>
                    <button type="button" onClick={() => setPendingReferenceIds((current) => current.filter((id) => id !== session.id))} title="移除引用"><X size={12} /></button>
                  </div>
                ))}
                {pendingImages.map((image) => (
                  <div className="composer-preview-chip image" key={image.id}>
                    <img src={image.preview} alt={image.name} />
                    <span>{image.name}</span>
                    <button type="button" onClick={() => setPendingImages((current) => current.filter((item) => item.id !== image.id))} title="移除图片"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-input-shell">
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
                  </div>
                )}
              </div>
              <textarea
                ref={composerRef}
                rows={1}
                defaultValue=""
                onBeforeInput={handleComposerBeforeInput}
                onInput={(event) => scheduleComposerSync(event.currentTarget)}
                onChange={(event) => scheduleComposerSync(event.currentTarget)}
                onCompositionStart={handleComposerComposition}
                onCompositionUpdate={handleComposerComposition}
                onCompositionEnd={handleComposerCompositionEnd}
                placeholder={isConnected ? "发送指令" : "桌面未连接"}
                disabled={!isConnected}
              />
              <button
                className={`send-button ${showAbortButton ? "abort" : queueSend ? "queue" : composerAction === "none" ? "empty" : ""}`}
                disabled={!isConnected || commandBusy}
                onClick={() => {
                  const action = getComposerAction({
                    text: composerRef.current?.value ?? composer,
                    composingText: composerComposition,
                    imageCount: pendingImages.length,
                    referenceCount: selectedReferenceSessions.length,
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
              <MobileModelPicker
                key={selected.session.id}
                agentName={selectedAgent?.name || selected.session.agentId}
                currentModel={selectedConfig?.model || null}
                models={selectedModels}
                disabled={commandBusy || (!demoMode && selected.session.status === "running")}
                onSelect={(model) => void switchModel(model)}
              />
              <MobileThinkingPicker
                value={selectedConfig?.thinkingLevel || "medium"}
                disabled={commandBusy || selected.session.status === "running"}
                onSelect={(level) => void runCommand<RemoteSessionConfig>("session.setThinking", { sessionId: selected.session.id, level }).then((config) => setConfigs((current) => ({ ...current, [selected.session.id]: config })))}
              />
            </div>
          </footer>
        </section>
      )}
    </main>
  );
}
