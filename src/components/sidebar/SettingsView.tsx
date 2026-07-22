import { useState, useEffect, useCallback, useRef } from "react";
import {
  AppWindow,
  Bot,
  ChevronDown,
  ChevronRight,
  Eraser,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Keyboard,
  ListFilter,
  Palette,
  RotateCcw,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Smartphone,
} from "lucide-react";
import { AgentSettingsView } from "./AgentSettingsView";
import { AgentConfigModal } from "./AgentConfigModal";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { applyAppTheme, normalizeAppTheme, type AppTheme } from "@/lib/theme";
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  normalizeShortcuts,
  SHORTCUTS_UPDATED_EVENT,
  type ShortcutConfig,
} from "@/lib/shortcuts";
import "./Settings.css";
import type { DiskUsageCategoryId, DiskUsageStats } from "@/types";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import { DISK_USAGE_INVALIDATED_EVENT } from "@/hooks/useDataPersistence";
import { publishFileFilters } from "@/hooks/useFileFilters";
import {
  DEFAULT_FILE_FILTERS,
  normalizeFileFilters,
  type FileFilterConfig,
} from "@shared/file-filters";

type FilterConfig = FileFilterConfig;

interface GeneralSettings {
  tempImagePath: string;
  imageRetentionHours: number;
  planModeEnabled: boolean;
  closeToTray: boolean;
  theme: AppTheme;
}

type GeneralSectionId = "appearance" | "behavior" | "editing" | "images" | "storage";

const SHORTCUT_LABELS: Record<string, string> = {
  fileSearch: "文件搜索",
  switchToFiles: "切换到资源管理器",
  prevModel: "上一个模型",
  nextModel: "下一个模型",
  previousMessage: "上一条消息",
  nextMessage: "下一条消息",
};

const DEFAULT_FILTERS = DEFAULT_FILE_FILTERS;

const IMAGE_RETENTION_HOURS = 12;
const THEME_OPTIONS: Array<{ value: AppTheme; label: string }> = [
  { value: "system", label: "系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const DISK_CATEGORY_LABELS: Record<DiskUsageCategoryId, string> = {
  conversations: "会话与快照",
  configuration: "应用配置",
  agentPlugins: "Agent 插件",
  agentRuntimes: "Agent 运行时",
  browserCache: "浏览器缓存",
  browserStorage: "浏览器存储",
  other: "其他数据",
};

const DISK_CATEGORY_DESCRIPTIONS: Partial<Record<DiskUsageCategoryId, string>> = {
  conversations: "项目与会话索引、消息、草稿快照和每会话模型配置",
  configuration: "通用设置、快捷键、过滤规则、主题和远程访问配置",
  agentRuntimes: "已安装 Agent 正常运行所需的本地依赖",
  browserCache: "可重建缓存，使用应用或重启后会再次生成",
};

const formatDiskSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeGeneral(value: unknown): GeneralSettings {
  const general = asRecord(value);
  return {
    tempImagePath: typeof general.tempImagePath === "string" ? general.tempImagePath : "",
    imageRetentionHours: IMAGE_RETENTION_HOURS,
    planModeEnabled: general.planModeEnabled === true,
    closeToTray: typeof general.closeToTray === "boolean" ? general.closeToTray : true,
    theme: normalizeAppTheme(general.theme),
  };
}

function getActiveSessionAgentId() {
  const projectState = useProjectStore.getState();
  const activeProject = projectState.projects.find((project) => project.id === projectState.activeProjectId);
  const activeSession = activeProject?.sessions.find((session) => session.id === projectState.activeSessionId);
  return activeSession?.agentId || useChatStore.getState().activeAgentId;
}

function syncActiveAgentModels(agentId: string, models?: Array<{ id: string; name: string; provider: string; reasoning: boolean; supportsImages?: boolean }>) {
  if (!models || models.length === 0) return;
  if (getActiveSessionAgentId() !== agentId) return;

  const chatStore = useChatStore.getState();
  chatStore.setAvailableModels(models);
  const currentModel = chatStore.currentModel;
  const matchingCurrentModel = currentModel ? models.find((model) =>
    model.id === currentModel.id && model.provider === currentModel.provider
  ) : undefined;
  chatStore.setCurrentModel(matchingCurrentModel || models[0]);
}

export function SettingsView() {
  const [shortcuts, setShortcuts] = useState<ShortcutConfig>(DEFAULT_SHORTCUTS);
  const [filters, setFilters] = useState<FilterConfig>(DEFAULT_FILTERS);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [showShortcutModal, setShowShortcutModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showGeneralModal, setShowGeneralModal] = useState(false);
  const [expandedGeneralSection, setExpandedGeneralSection] = useState<GeneralSectionId | null>("appearance");
  const [showAgentSettingsModal, setShowAgentSettingsModal] = useState(false);
  const [showRemoteAccessModal, setShowRemoteAccessModal] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [tempImagePath, setTempImagePath] = useState("");
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [closeToTray, setCloseToTray] = useState(true);
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [diskUsage, setDiskUsage] = useState<DiskUsageStats | null>(null);
  const [diskUsageLoading, setDiskUsageLoading] = useState(false);
  const [diskCleanupLoading, setDiskCleanupLoading] = useState(false);
  const [diskUsageError, setDiskUsageError] = useState("");
  const storageSectionOpenRef = useRef(false);
  const [newFolder, setNewFolder] = useState("");
  const [newExt, setNewExt] = useState("");
  const [newFile, setNewFile] = useState("");
  const agents = useAgentCatalogStore((state) => state.agents);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);
  const projects = useProjectStore((state) => state.projects);
  const retainedSessionCount = projects.reduce((total, project) => total + project.sessions.length, 0);
  const closedSessionCount = projects.reduce(
    (total, project) => total + project.sessions.filter((session) => session.closed).length,
    0,
  );

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Load saved settings on mount
  useEffect(() => {
    window.electronAPI.loadData("settings").then((data) => {
      const settings = asRecord(data);
      if (settings.shortcuts) setShortcuts(normalizeShortcuts(settings.shortcuts));
      if (settings.filters) setFilters(normalizeFileFilters(settings.filters));
      if (settings.general) {
        const originalGeneral = asRecord(settings.general);
        const general = normalizeGeneral(settings.general);
        setTempImagePath(general.tempImagePath);
        setPlanModeEnabled(general.planModeEnabled);
        setCloseToTray(general.closeToTray);
        setTheme(general.theme);
        applyAppTheme(general.theme);
        if (originalGeneral.imageRetentionHours !== IMAGE_RETENTION_HOURS) {
          void window.electronAPI.saveData("settings", {
            ...settings,
            general: {
              ...originalGeneral,
              imageRetentionHours: IMAGE_RETENTION_HOURS,
            },
          });
        }
      }
    });
  }, []);

  const refreshDiskUsage = useCallback(async () => {
    if (diskUsageLoading) return;
    setDiskUsageLoading(true);
    setDiskUsageError("");
    try {
      setDiskUsage(await window.electronAPI.getDiskUsage());
    } catch (error) {
      setDiskUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiskUsageLoading(false);
    }
  }, [diskUsageLoading]);

  const cleanupDiskUsage = useCallback(async () => {
    if (diskCleanupLoading || diskUsageLoading) return;
    const sessionSummary = closedSessionCount > 0
      ? `当前保留 ${retainedSessionCount} 个会话，其中 ${closedSessionCount} 个在历史中。`
      : `当前保留 ${retainedSessionCount} 个会话。`;
    const cleanupNotice = [
      "将清理无主会话数据、已卸载插件遗留的运行时和可重建缓存。",
      "",
      sessionSummary,
      "删除会话只会减少“会话与快照”。",
      "浏览器缓存会在使用或重启后重新生成。",
      "",
      "不会删除现有会话、插件或正在使用的 Agent 运行时。继续清理吗？",
    ].join("\n");
    if (!window.confirm(cleanupNotice)) return;
    setDiskCleanupLoading(true);
    setDiskUsageError("");
    try {
      const projects = useProjectStore.getState().projects;
      const validSessionIds = projects.flatMap((project) => project.sessions.map((session) => session.id));
      const purgeResult = await window.electronAPI.purgeSessionData({
        validSessionIds,
        validProjectIds: projects.map((project) => project.id),
      });
      if (!purgeResult.success) throw new Error(purgeResult.error || "清理无主会话数据失败");
      const result = await window.electronAPI.cleanupDiskCache();
      setDiskUsage(result.stats);
      showFloatingToastMessage(
        result.reclaimedBytes > 0
          ? `已清理 ${formatDiskSize(result.reclaimedBytes)}`
          : "未发现可清理数据",
      );
    } catch (error) {
      setDiskUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiskCleanupLoading(false);
    }
  }, [closedSessionCount, diskCleanupLoading, diskUsageLoading, retainedSessionCount]);

  useEffect(() => {
    const storageOpen = showGeneralModal && expandedGeneralSection === "storage";
    if (storageOpen && !storageSectionOpenRef.current && !diskUsageLoading) {
      void refreshDiskUsage();
    }
    storageSectionOpenRef.current = storageOpen;
  }, [diskUsageLoading, expandedGeneralSection, refreshDiskUsage, showGeneralModal]);

  useEffect(() => {
    const handleDiskUsageInvalidated = () => {
      if (showGeneralModal && expandedGeneralSection === "storage") {
        void refreshDiskUsage();
      }
    };
    window.addEventListener(DISK_USAGE_INVALIDATED_EVENT, handleDiskUsageInvalidated);
    return () => window.removeEventListener(DISK_USAGE_INVALIDATED_EVENT, handleDiskUsageInvalidated);
  }, [expandedGeneralSection, refreshDiskUsage, showGeneralModal]);

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        if (!cancelled) setAppVersion("0.0.1");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ planModeEnabled?: boolean }>).detail;
      if (typeof detail?.planModeEnabled === "boolean") {
        setPlanModeEnabled(detail.planModeEnabled);
      }
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
  }, []);

  // Save shortcuts when changed
  const saveSettings = useCallback(async (
    nextShortcuts = shortcuts,
    nextFilters = filters,
    nextGeneral?: GeneralSettings,
  ) => {
    const data = await window.electronAPI.loadData("settings");
    const currentSettings = asRecord(data);
    const currentGeneral = asRecord(currentSettings.general);
    const generalValues = nextGeneral ?? {
      tempImagePath,
      imageRetentionHours: IMAGE_RETENTION_HOURS,
      planModeEnabled,
      closeToTray,
      theme,
    };
    const nextSettings = {
      ...currentSettings,
      shortcuts: nextShortcuts,
      filters: nextFilters,
      general: {
        ...currentGeneral,
        ...generalValues,
      },
    };

    await window.electronAPI.saveData("settings", nextSettings);
  }, [shortcuts, filters, tempImagePath, planModeEnabled, closeToTray, theme]);

  const saveShortcuts = (s: ShortcutConfig) => {
    setShortcuts(s);
    void saveSettings(s, filters);
    window.dispatchEvent(new CustomEvent(SHORTCUTS_UPDATED_EVENT, { detail: s }));
  };

  const saveFilters = (f: FilterConfig) => {
    const normalized = normalizeFileFilters(f);
    setFilters(normalized);
    void saveSettings(shortcuts, normalized);
    publishFileFilters(normalized);
  };

  const updateCloseToTray = (enabled: boolean) => {
    setCloseToTray(enabled);
    void saveSettings(shortcuts, filters, {
      tempImagePath,
      imageRetentionHours: IMAGE_RETENTION_HOURS,
      planModeEnabled,
      closeToTray: enabled,
      theme,
    });
    void window.electronAPI.setCloseToTray(enabled);
  };

  const updateTheme = (nextTheme: AppTheme) => {
    setTheme(nextTheme);
    applyAppTheme(nextTheme);
    void window.electronAPI.setAppTheme(nextTheme);
    void saveSettings(shortcuts, filters, {
      tempImagePath,
      imageRetentionHours: IMAGE_RETENTION_HOURS,
      planModeEnabled,
      closeToTray,
      theme: nextTheme,
    });
  };

  const updateTempImagePath = (nextPath: string) => {
    setTempImagePath(nextPath);
    void saveSettings(shortcuts, filters, {
      tempImagePath: nextPath,
      imageRetentionHours: IMAGE_RETENTION_HOURS,
      planModeEnabled,
      closeToTray,
      theme,
    });
  };

  const openAgentConfig = () => {
    setConfigAgentId(getActiveSessionAgentId() || agents[0]?.id || null);
  };

  const configAgent = configAgentId
    ? agents.find((agent) => agent.id === configAgentId) || null
    : null;

  // Keyboard recording handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recordingKey) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = formatShortcut(e);
    if (!combo) return; // modifier-only, ignore

    const newShortcuts = { ...shortcuts, [recordingKey]: combo };
    saveShortcuts(newShortcuts);
    setRecordingKey(null);
  }, [recordingKey, shortcuts, filters]);

  useEffect(() => {
    if (recordingKey) {
      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }
  }, [recordingKey, handleKeyDown]);

  const addFolder = () => {
    if (newFolder.trim()) {
      const newFilters = { ...filters, excludeFolders: [...filters.excludeFolders, newFolder.trim()] };
      saveFilters(newFilters);
      setNewFolder("");
    }
  };

  const addExt = () => {
    if (newExt.trim()) {
      const ext = newExt.startsWith(".") ? newExt.trim() : `.${newExt.trim()}`;
      const newFilters = { ...filters, excludeExtensions: [...filters.excludeExtensions, ext] };
      saveFilters(newFilters);
      setNewExt("");
    }
  };

  const addFile = () => {
    if (newFile.trim()) {
      const newFilters = { ...filters, excludeFiles: [...filters.excludeFiles, newFile.trim()] };
      saveFilters(newFilters);
      setNewFile("");
    }
  };

  const openShortcutSettings = () => {
    setShowGeneralModal(false);
    setRecordingKey(null);
    setShowShortcutModal(true);
  };

  const closeShortcutSettings = () => {
    setShowShortcutModal(false);
    setRecordingKey(null);
    setShowGeneralModal(true);
  };

  const openFilterSettings = () => {
    setShowGeneralModal(false);
    setShowFilterModal(true);
  };

  const closeFilterSettings = () => {
    setShowFilterModal(false);
    setShowGeneralModal(true);
  };

  const openGeneralSettings = () => {
    setExpandedGeneralSection("appearance");
    setShowGeneralModal(true);
  };

  const filterRuleCount = filters.excludeFolders.length
    + filters.excludeExtensions.length
    + filters.excludeFiles.length;

  const toggleGeneralSection = (section: GeneralSectionId) => {
    setExpandedGeneralSection((current) => current === section ? null : section);
  };

  return (
    <div className="settings">
      <div className="settings-header">
        <span>设置</span>
        <span className="settings-header-version">Hpp v{appVersion || "0.0.1"}</span>
      </div>

      <div className="settings-content">
        <div className="settings-section">
          <div className="settings-quick-buttons">
            <button
              onClick={() => setShowAgentSettingsModal(true)}
              className="btn-quick-setting"
            >
              <Bot size={16} strokeWidth={1.8} />
              Agent
            </button>
            <button
              onClick={() => setShowRemoteAccessModal(true)}
              className="btn-quick-setting"
            >
              <Smartphone size={16} strokeWidth={1.8} />
              远程访问
            </button>
            <button
              onClick={openGeneralSettings}
              className="btn-quick-setting"
            >
              <SlidersHorizontal size={16} strokeWidth={1.8} />
              通用设置
            </button>
          </div>
        </div>
      </div>

      {showShortcutModal && (
        <div className="settings-modal-overlay" onClick={closeShortcutSettings}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>快捷键设置</h3>
              <button onClick={closeShortcutSettings} className="settings-modal-close">×</button>
            </div>
            <div className="settings-modal-content">
              <div className="shortcut-list">
                {/* 发送方式：下拉选择 */}
                <div className="shortcut-item">
                  <span className="shortcut-label">发送消息</span>
                  <div className="shortcut-control">
                    <select
                      className="send-mode-select"
                      value={shortcuts.sendKey}
                      onChange={(e) => saveShortcuts({ ...shortcuts, sendKey: e.target.value })}
                    >
                      <option value="Enter">Enter 发送</option>
                      <option value="Ctrl+Enter">Ctrl + Enter 发送</option>
                    </select>
                  </div>
                </div>
                {Object.entries(shortcuts).filter(([k]) =>
                  k !== "sendKey" &&
                  k !== "prevModel" &&
                  k !== "nextModel" &&
                  k !== "previousMessage" &&
                  k !== "nextMessage"
                ).map(([key, value]) => {
                  const isRecording = recordingKey === key;
                  return (
                    <div key={key} className="shortcut-item">
                      <span className="shortcut-label">{SHORTCUT_LABELS[key] || key}</span>
                      <div className="shortcut-control">
                        <button
                          className={`shortcut-btn ${isRecording ? "recording" : ""}`}
                          onClick={() => setRecordingKey(isRecording ? null : key)}
                        >
                          {isRecording ? "按下快捷键..." : value}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {/* 模型切换：两个快捷键在同一行 */}
                <div className="shortcut-item">
                  <span className="shortcut-label">切换模型</span>
                  <div className="shortcut-control" style={{ display: "flex", gap: 8 }}>
                    {(["prevModel", "nextModel"] as const).map((key) => {
                      const isRecording = recordingKey === key;
                      return (
                        <button
                          key={key}
                          className={`shortcut-btn ${isRecording ? "recording" : ""}`}
                          onClick={() => setRecordingKey(isRecording ? null : key)}
                          title={key === "prevModel" ? "上一个" : "下一个"}
                        >
                          {isRecording ? "按下..." : `${key === "prevModel" ? "上一个" : "下一个"}: ${shortcuts[key]}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">切换消息</span>
                  <div className="shortcut-control" style={{ display: "flex", gap: 8 }}>
                    {(["previousMessage", "nextMessage"] as const).map((key) => {
                      const isRecording = recordingKey === key;
                      return (
                        <button
                          key={key}
                          className={`shortcut-btn ${isRecording ? "recording" : ""}`}
                          onClick={() => setRecordingKey(isRecording ? null : key)}
                          title={key === "previousMessage" ? "上一条" : "下一条"}
                        >
                          {isRecording ? "按下..." : `${key === "previousMessage" ? "上一条" : "下一条"}: ${shortcuts[key]}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 12 }}>
                点击快捷键按钮后，按下新的组合键即可设置。按 Esc 取消。
              </p>
            </div>
          </div>
        </div>
      )}

      {showFilterModal && (
        <div className="settings-modal-overlay" onClick={closeFilterSettings}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>过滤规则</h3>
              <button onClick={closeFilterSettings} className="settings-modal-close">×</button>
            </div>
            <div className="settings-modal-content">
              <div className="filter-group">
                <div className="filter-row">
                  <label>排除文件夹</label>
                  <div className="filter-custom-list">
                    {filters.excludeFolders.map((f) => (
                      <span key={f} className="filter-custom-tag">
                        {f}
                        <button onClick={() => saveFilters({ ...filters, excludeFolders: filters.excludeFolders.filter((x) => x !== f) })} className="filter-custom-remove">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="filter-custom-ext">
                    <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFolder()} placeholder="添加文件夹" className="filter-custom-input" />
                    <button onClick={addFolder} className="filter-add-btn">添加</button>
                  </div>
                </div>

                <div className="filter-row">
                  <label>排除文件后缀</label>
                  <div className="filter-custom-list">
                    {filters.excludeExtensions.map((ext) => (
                      <span key={ext} className="filter-custom-tag">
                        {ext}
                        <button onClick={() => saveFilters({ ...filters, excludeExtensions: filters.excludeExtensions.filter((x) => x !== ext) })} className="filter-custom-remove">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="filter-custom-ext">
                    <input value={newExt} onChange={(e) => setNewExt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addExt()} placeholder="如 .log" className="filter-custom-input" />
                    <button onClick={addExt} className="filter-add-btn">添加</button>
                  </div>
                </div>

                <div className="filter-row">
                  <label>排除文件名</label>
                  <div className="filter-custom-list">
                    {filters.excludeFiles.map((f) => (
                      <span key={f} className="filter-custom-tag">
                        {f}
                        <button onClick={() => saveFilters({ ...filters, excludeFiles: filters.excludeFiles.filter((x) => x !== f) })} className="filter-custom-remove">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="filter-custom-ext">
                    <input value={newFile} onChange={(e) => setNewFile(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFile()} placeholder="如 .env" className="filter-custom-input" />
                    <button onClick={addFile} className="filter-add-btn">添加</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {showAgentSettingsModal && (
        <div className="settings-modal-overlay" onClick={() => setShowAgentSettingsModal(false)}>
          <div className="settings-modal settings-modal-agent" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <div className="settings-modal-title-actions">
                <h3>Agent</h3>
                <button
                  type="button"
                  className="btn-icon settings-modal-header-icon"
                  onClick={openAgentConfig}
                  title="配置 Agent 渠道和模型"
                  aria-label="配置 Agent 渠道和模型"
                >
                  <Settings size={15} />
                </button>
              </div>
              <button onClick={() => setShowAgentSettingsModal(false)} className="settings-modal-close">×</button>
            </div>
            <div className="settings-modal-content">
              <AgentSettingsView embedded />
            </div>
          </div>
        </div>
      )}
      {showRemoteAccessModal && (
        <RemoteAccessSettings onClose={() => setShowRemoteAccessModal(false)} />
      )}
      {configAgent && (
        <AgentConfigModal
          agentId={configAgent.id}
          agentName={configAgent.name}
          onClose={() => setConfigAgentId(null)}
          onModelsUpdated={syncActiveAgentModels}
        />
      )}
      {showGeneralModal && (
        <div className="settings-modal-overlay" onClick={() => setShowGeneralModal(false)}>
          <div className="settings-modal settings-general-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <div className="settings-general-title">
                <span className="settings-general-title-icon"><SlidersHorizontal size={17} /></span>
                <div>
                  <h3>通用设置</h3>
                  <span>管理外观、应用行为与工作区偏好</span>
                </div>
              </div>
              <button onClick={() => setShowGeneralModal(false)} className="settings-modal-close">×</button>
            </div>
            <div className="settings-modal-content settings-general-content">
              <section className={`settings-general-section ${expandedGeneralSection === "appearance" ? "expanded" : "collapsed"}`}>
                <button
                  type="button"
                  className="settings-general-heading settings-general-heading-button"
                  onClick={() => toggleGeneralSection("appearance")}
                  aria-expanded={expandedGeneralSection === "appearance"}
                  aria-controls="general-settings-appearance"
                >
                  <span className="settings-general-heading-icon"><Palette size={15} /></span>
                  <div>
                    <h4>外观</h4>
                    <p>选择 Hpp 的界面明暗模式</p>
                  </div>
                  <ChevronDown className="settings-general-collapse-icon" size={16} />
                </button>
                {expandedGeneralSection === "appearance" && (
                  <div id="general-settings-appearance" className="settings-general-section-body">
                    <div className="settings-theme-options" role="radiogroup" aria-label="主题">
                      {THEME_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={theme === option.value}
                          className={`settings-theme-option ${theme === option.value ? "selected" : ""}`}
                          onClick={() => updateTheme(option.value)}
                        >
                          <span className={`settings-theme-preview ${option.value}`} aria-hidden="true">
                            <span className="settings-theme-preview-rail" />
                            <span className="settings-theme-preview-panel">
                              <span className="settings-theme-preview-line wide" />
                              <span className="settings-theme-preview-line" />
                              <span className="settings-theme-preview-line short" />
                            </span>
                          </span>
                          <span className="settings-theme-option-label">{option.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className={`settings-general-section ${expandedGeneralSection === "behavior" ? "expanded" : "collapsed"}`}>
                <button
                  type="button"
                  className="settings-general-heading settings-general-heading-button"
                  onClick={() => toggleGeneralSection("behavior")}
                  aria-expanded={expandedGeneralSection === "behavior"}
                  aria-controls="general-settings-behavior"
                >
                  <span className="settings-general-heading-icon"><AppWindow size={15} /></span>
                  <div>
                    <h4>应用行为</h4>
                    <p>控制桌面窗口关闭时的行为</p>
                  </div>
                  <ChevronDown className="settings-general-collapse-icon" size={16} />
                </button>
                {expandedGeneralSection === "behavior" && (
                  <div id="general-settings-behavior" className="settings-general-section-body">
                    <label className="settings-general-row settings-general-toggle">
                      <span className="settings-general-row-main">
                        <strong>关闭时最小化到托盘</strong>
                        <span>关闭主窗口后保持 Hpp 在后台运行，可从系统托盘重新打开</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={closeToTray}
                        onChange={(event) => updateCloseToTray(event.target.checked)}
                        aria-label="关闭时最小化到托盘"
                      />
                    </label>
                  </div>
                )}
              </section>

              <section className={`settings-general-section ${expandedGeneralSection === "editing" ? "expanded" : "collapsed"}`}>
                <button
                  type="button"
                  className="settings-general-heading settings-general-heading-button"
                  onClick={() => toggleGeneralSection("editing")}
                  aria-expanded={expandedGeneralSection === "editing"}
                  aria-controls="general-settings-editing"
                >
                  <span className="settings-general-heading-icon"><Settings size={15} /></span>
                  <div>
                    <h4>编辑与文件</h4>
                    <p>配置输入方式和项目文件的索引范围</p>
                  </div>
                  <ChevronDown className="settings-general-collapse-icon" size={16} />
                </button>
                {expandedGeneralSection === "editing" && (
                  <div id="general-settings-editing" className="settings-general-section-body">
                    <div className="settings-general-links">
                      <button type="button" className="settings-general-link" onClick={openShortcutSettings}>
                        <span className="settings-general-link-icon"><Keyboard size={16} /></span>
                        <span className="settings-general-row-main">
                          <strong>快捷键</strong>
                          <span>{shortcuts.sendKey} 发送，支持文件搜索与模型切换</span>
                        </span>
                        <span className="settings-general-link-meta">{Object.keys(shortcuts).length} 项</span>
                        <ChevronRight size={16} />
                      </button>
                      <button type="button" className="settings-general-link" onClick={openFilterSettings}>
                        <span className="settings-general-link-icon"><ListFilter size={16} /></span>
                        <span className="settings-general-row-main">
                          <strong>过滤规则</strong>
                          <span>排除不需要索引的文件夹、后缀和文件名</span>
                        </span>
                        <span className="settings-general-link-meta">{filterRuleCount} 条</span>
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className={`settings-general-section ${expandedGeneralSection === "images" ? "expanded" : "collapsed"}`}>
                <button
                  type="button"
                  className="settings-general-heading settings-general-heading-button"
                  onClick={() => toggleGeneralSection("images")}
                  aria-expanded={expandedGeneralSection === "images"}
                  aria-controls="general-settings-images"
                >
                  <span className="settings-general-heading-icon"><ImageIcon size={15} /></span>
                  <div>
                    <h4>图片与缓存</h4>
                    <p>临时图片将在 12 小时后自动清理</p>
                  </div>
                  <ChevronDown className="settings-general-collapse-icon" size={16} />
                </button>
                {expandedGeneralSection === "images" && (
                  <div id="general-settings-images" className="settings-general-section-body">
                    <div className="settings-general-row settings-general-path-row">
                      <span className="settings-general-row-main">
                        <strong>临时图片存储路径</strong>
                        <span>留空时使用 Hpp 默认缓存目录</span>
                      </span>
                      <div className="settings-general-path-control">
                        <input
                          value={tempImagePath}
                          readOnly
                          placeholder="默认路径"
                          className="filter-custom-input"
                          title={tempImagePath || "使用默认路径"}
                        />
                        <button
                          type="button"
                          className="settings-general-icon-button"
                          onClick={() => updateTempImagePath("")}
                          disabled={!tempImagePath}
                          title="恢复默认路径"
                          aria-label="恢复默认路径"
                        >
                          <RotateCcw size={14} />
                        </button>
                        <button
                          type="button"
                          className="settings-general-icon-button"
                          onClick={async () => {
                            const result = await window.electronAPI.openDirectory();
                            if (!result.canceled && result.path) updateTempImagePath(result.path);
                          }}
                          title="选择文件夹"
                          aria-label="选择文件夹"
                        >
                          <FolderOpen size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              <section className={`settings-general-section ${expandedGeneralSection === "storage" ? "expanded" : "collapsed"}`}>
                <button
                  type="button"
                  className="settings-general-heading settings-general-heading-button"
                  onClick={() => toggleGeneralSection("storage")}
                  aria-expanded={expandedGeneralSection === "storage"}
                  aria-controls="general-settings-storage"
                >
                  <span className="settings-general-heading-icon"><HardDrive size={15} /></span>
                  <div>
                    <h4>存储</h4>
                    <p>{diskUsage ? `${formatDiskSize(diskUsage.totalSizeBytes)} · ${diskUsage.totalFileCount} 个文件` : "查看 Hpp 本地磁盘占用"}</p>
                  </div>
                  <ChevronDown className="settings-general-collapse-icon" size={16} />
                </button>
                {expandedGeneralSection === "storage" && (
                  <div id="general-settings-storage" className="settings-general-section-body settings-storage-body">
                    <div className="settings-storage-summary">
                      <div>
                        <span>当前占用</span>
                        <strong>{diskUsage ? formatDiskSize(diskUsage.totalSizeBytes) : "--"}</strong>
                      </div>
                      <div className="settings-storage-actions">
                        <button
                          type="button"
                          className="settings-general-icon-button"
                          onClick={() => void cleanupDiskUsage()}
                          disabled={diskCleanupLoading || diskUsageLoading}
                          title="清理无用数据"
                          aria-label="清理无用数据"
                        >
                          <Eraser size={14} />
                        </button>
                        <button
                          type="button"
                          className="settings-general-icon-button"
                          onClick={() => void refreshDiskUsage()}
                          disabled={diskUsageLoading || diskCleanupLoading}
                          title="刷新磁盘占用"
                          aria-label="刷新磁盘占用"
                        >
                          <RefreshCw size={14} className={diskUsageLoading ? "settings-storage-refreshing" : undefined} />
                        </button>
                      </div>
                    </div>
                    {diskUsageError && <div className="settings-storage-state error">读取失败：{diskUsageError}</div>}
                    {(diskUsageLoading || diskCleanupLoading) && !diskUsage && (
                      <div className="settings-storage-state">{diskCleanupLoading ? "正在清理..." : "正在统计..."}</div>
                    )}
                    {diskUsage && (
                      <div className="settings-storage-list">
                        {diskUsage.categories.map((category) => {
                          const percentage = diskUsage.totalSizeBytes > 0
                            ? Math.max(1, (category.sizeBytes / diskUsage.totalSizeBytes) * 100)
                            : 0;
                          return (
                            <div
                              key={category.id}
                              className="settings-storage-row"
                              title={DISK_CATEGORY_DESCRIPTIONS[category.id]}
                            >
                              <div className="settings-storage-row-label">
                                <span>{DISK_CATEGORY_LABELS[category.id]}</span>
                                <strong>{formatDiskSize(category.sizeBytes)}</strong>
                              </div>
                              <div className="settings-storage-meter" aria-hidden="true">
                                <span style={{ width: `${percentage}%` }} />
                              </div>
                              <small>
                                {category.id === "conversations"
                                  ? `${retainedSessionCount} 个会话 · ${category.fileCount} 个文件`
                                  : `${category.fileCount} 个文件`}
                              </small>
                            </div>
                          );
                        })}
                        {diskUsage.categories.length === 0 && <div className="settings-storage-state">暂无本地数据</div>}
                      </div>
                    )}
                    {diskUsage && (
                      <div className="settings-storage-path" title={diskUsage.dataPath}>
                        <span>存储位置</span>
                        <code>{diskUsage.dataPath}</code>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
