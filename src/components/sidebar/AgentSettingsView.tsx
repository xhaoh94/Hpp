import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileArchive, FolderOpen, GripVertical, PackagePlus, RefreshCw, Settings, X } from "lucide-react";
import {
  getAgentPlanModeTooltip,
  normalizeAgentOrder,
  orderAgents,
  supportsNativePlanMode,
} from "@/lib/agents";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import type { AgentDescriptor, AgentPackageStatus, AgentPluginInstallResult, OfficialAgentPluginDescriptor } from "@/types";
import { AgentConfigModal } from "./AgentConfigModal";
import "./Settings.css";

const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";
const VERSION_CACHE_MS = 60_000;

let cachedAgentStatuses: Record<string, AgentPackageStatus> = {};
let lastAgentChecks: Record<string, number> = {};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

async function loadSettings() {
  return asRecord(await window.electronAPI.loadData("settings"));
}

function getActiveSessionAgentId() {
  const projectState = useProjectStore.getState();
  const activeProject = projectState.projects.find((project) => project.id === projectState.activeProjectId);
  const activeSession = activeProject?.sessions.find((session) => session.id === projectState.activeSessionId);
  return activeSession?.agentId || useChatStore.getState().activeAgentId;
}

function filterKnownAgentIds(ids: string[], agents: AgentDescriptor[]) {
  const knownIds = new Set(agents.map((agent) => agent.id));
  return ids.filter((id) => knownIds.has(id));
}

function defaultEnabledAgents(agents: AgentDescriptor[]) {
  return agents.map((agent) => agent.id);
}

function syncActiveAgentModels(
  agentId: string,
  models?: Array<{ id: string; name: string; provider: string; reasoning: boolean; supportsImages?: boolean }>
) {
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

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface AgentSettingsViewProps {
  embedded?: boolean;
}

export function AgentSettingsView({ embedded = false }: AgentSettingsViewProps) {
  const [enabledAgents, setEnabledAgents] = useState<string[]>([]);
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentPackageStatus>>({});
  const [agentChecking, setAgentChecking] = useState<Record<string, boolean>>({});
  const [agentUpdating, setAgentUpdating] = useState<Record<string, boolean>>({});
  const [agentUpdateErrors, setAgentUpdateErrors] = useState<Record<string, string>>({});
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [pluginPath, setPluginPath] = useState("");
  const [pluginStatus, setPluginStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [installingPlugin, setInstallingPlugin] = useState(false);
  const [installingOfficialAgentIds, setInstallingOfficialAgentIds] = useState<Record<string, boolean>>({});
  const [removingAgentId, setRemovingAgentId] = useState("");
  const [removeConfirmAgentId, setRemoveConfirmAgentId] = useState<string | null>(null);
  const [removeLocalRuntime, setRemoveLocalRuntime] = useState(false);
  const [showLocalPluginModal, setShowLocalPluginModal] = useState(false);
  const [showOfficialPluginModal, setShowOfficialPluginModal] = useState(false);
  const officialInstallQueueRef = useRef<Promise<void>>(Promise.resolve());
  const installResultQueueRef = useRef<Promise<void>>(Promise.resolve());

  const agents = useAgentCatalogStore((state) => state.agents);
  const officialPlugins = useAgentCatalogStore((state) => state.officialPlugins);
  const officialLoading = useAgentCatalogStore((state) => state.officialLoading);
  const officialError = useAgentCatalogStore((state) => state.officialError);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);
  const reloadAgents = useAgentCatalogStore((state) => state.reloadAgents);
  const installPluginFromPath = useAgentCatalogStore((state) => state.installPluginFromPath);
  const loadOfficialPlugins = useAgentCatalogStore((state) => state.loadOfficialPlugins);
  const installOfficialPlugin = useAgentCatalogStore((state) => state.installOfficialPlugin);
  const removePlugin = useAgentCatalogStore((state) => state.removePlugin);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void loadOfficialPlugins();
  }, [loadOfficialPlugins]);

  const saveAgentSettings = useCallback(async (
    nextEnabledAgents = enabledAgents,
    nextAgentOrder = agentOrder,
    agentList = agents,
  ) => {
    const settings = await loadSettings();
    const general = asRecord(settings.general);
    const normalizedEnabled = filterKnownAgentIds(nextEnabledAgents, agentList);
    const normalizedOrder = normalizeAgentOrder(nextAgentOrder, agentList);
    const nextSettings = {
      ...settings,
      general: {
        ...general,
        enabledAgents: normalizedEnabled,
        agentOrder: normalizedOrder,
      },
    };

    await window.electronAPI.saveData("settings", nextSettings);
    window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_UPDATED_EVENT, {
      detail: {
        enabledAgents: normalizedEnabled,
        agentOrder: normalizedOrder,
        planModeEnabled: typeof general.planModeEnabled === "boolean" ? general.planModeEnabled : undefined,
      },
    }));
  }, [agentOrder, agents, enabledAgents]);

  const refreshAgentStatus = useCallback(async (agentId: string) => {
    setAgentChecking((prev) => ({ ...prev, [agentId]: true }));
    try {
      const status = await window.electronAPI.agentGetStatus(agentId);
      cachedAgentStatuses[agentId] = status;
      lastAgentChecks[agentId] = Date.now();
      setAgentStatuses((prev) => ({ ...prev, [agentId]: status }));
      setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: "" }));
    } catch (error) {
      delete cachedAgentStatuses[agentId];
      setAgentStatuses((prev) => ({
        ...prev,
        [agentId]: {
          installed: false,
          updateAvailable: false,
          canUpdate: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setAgentChecking((prev) => ({ ...prev, [agentId]: false }));
    }
  }, []);

  const handleAgentUpdate = useCallback(async (agentId: string) => {
    setAgentUpdating((prev) => ({ ...prev, [agentId]: true }));
    setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: "" }));
    try {
      const result = await window.electronAPI.agentUpdate(agentId);
      if (result.status) {
        cachedAgentStatuses[agentId] = result.status;
        lastAgentChecks[agentId] = Date.now();
        setAgentStatuses((prev) => ({ ...prev, [agentId]: result.status! }));
      }
      if (!result.success) {
        setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: result.error || "更新失败" }));
      }
    } catch (error) {
      setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setAgentUpdating((prev) => ({ ...prev, [agentId]: false }));
    }
  }, []);

  const moveAgent = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const currentOrder = normalizeAgentOrder(agentOrder, agents);
    const fromIndex = currentOrder.indexOf(sourceId);
    const toIndex = currentOrder.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setAgentOrder(nextOrder);
    void saveAgentSettings(enabledAgents, nextOrder);
  }, [agentOrder, agents, enabledAgents, saveAgentSettings]);

  useEffect(() => {
    let cancelled = false;

    loadSettings().then((settings) => {
      if (cancelled) return;
      const general = asRecord(settings.general);
      const savedEnabled = getStringArray(general.enabledAgents);
      const savedOrder = getStringArray(general.agentOrder);
      setEnabledAgents(savedEnabled ? filterKnownAgentIds(savedEnabled, agents) : defaultEnabledAgents(agents));
      setAgentOrder(normalizeAgentOrder(savedOrder, agents));
    });

    return () => {
      cancelled = true;
    };
  }, [agents]);

  useEffect(() => {
    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ enabledAgents?: string[]; agentOrder?: string[] }>).detail;
      if (Array.isArray(detail?.enabledAgents)) setEnabledAgents(filterKnownAgentIds(detail.enabledAgents, agents));
      if (detail?.agentOrder) setAgentOrder(normalizeAgentOrder(detail.agentOrder, agents));
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
  }, [agents]);

  useEffect(() => {
    const now = Date.now();
    for (const agent of agents) {
      if (now - (lastAgentChecks[agent.id] || 0) > VERSION_CACHE_MS) {
        void refreshAgentStatus(agent.id);
      } else if (cachedAgentStatuses[agent.id]) {
        setAgentStatuses((prev) => ({ ...prev, [agent.id]: cachedAgentStatuses[agent.id]! }));
      }
    }
  }, [agents, refreshAgentStatus]);

  const openAgentConfig = useCallback(() => {
    const activeAgentId = getActiveSessionAgentId();
    setConfigAgentId(activeAgentId || agents[0]?.id || null);
  }, [agents]);

  const configAgent = configAgentId
    ? agents.find((agent) => agent.id === configAgentId) || null
    : null;

  const handleChoosePluginPath = useCallback(async (kind: "zip" | "directory") => {
    const result = await window.electronAPI.agentPluginChoosePath(kind);
    if (!result.canceled && result.path) setPluginPath(result.path);
  }, []);

  const applyInstalledPluginResult = useCallback((result: AgentPluginInstallResult) => {
    const installedAgent = result.agent;
    if (!installedAgent) return Promise.resolve();

    const applyResult = installResultQueueRef.current.then(async () => {
      const nextAgents = result.agents || agents;
      const settings = await loadSettings();
      const general = asRecord(settings.general);
      const currentEnabledAgents = getStringArray(general.enabledAgents) ?? enabledAgents;
      const currentAgentOrder = getStringArray(general.agentOrder) ?? agentOrder;
      const nextEnabledAgents = currentEnabledAgents.includes(installedAgent.id)
        ? currentEnabledAgents
        : [...currentEnabledAgents, installedAgent.id];
      const nextAgentOrder = normalizeAgentOrder([...currentAgentOrder, installedAgent.id], nextAgents);
      setEnabledAgents(filterKnownAgentIds(nextEnabledAgents, nextAgents));
      setAgentOrder(nextAgentOrder);
      delete cachedAgentStatuses[installedAgent.id];
      delete lastAgentChecks[installedAgent.id];
      await saveAgentSettings(nextEnabledAgents, nextAgentOrder, nextAgents);
    });

    installResultQueueRef.current = applyResult.catch(() => undefined);
    return applyResult;
  }, [agentOrder, agents, enabledAgents, saveAgentSettings]);

  const handleInstallPlugin = useCallback(async () => {
    const nextPath = pluginPath.trim();
    if (!nextPath) {
      setPluginStatus({ type: "error", text: "请选择插件目录或 ZIP 文件" });
      return;
    }
    const trusted = window.confirm("本地 Agent 插件会在主进程中执行 JavaScript。请只安装你信任的插件。是否继续安装？");
    if (!trusted) return;

    setInstallingPlugin(true);
    setPluginStatus(null);
    try {
      const result = await installPluginFromPath(nextPath);
      if (!result.success) {
        setPluginStatus({ type: "error", text: result.error || "插件安装失败" });
        return;
      }
      await applyInstalledPluginResult(result);
      setPluginPath("");
      setShowLocalPluginModal(false);
      setPluginStatus({
        type: "success",
        text: `${result.agent?.name || "插件"} ${result.replaced ? "已更新" : "已安装"}`,
      });
    } catch (error) {
      setPluginStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstallingPlugin(false);
    }
  }, [applyInstalledPluginResult, installPluginFromPath, pluginPath]);

  const handleInstallOfficialPlugin = useCallback(async (plugin: OfficialAgentPluginDescriptor) => {
    const trusted = window.confirm("官方 Agent 插件会在主进程中执行 JavaScript。请确认信任 xhaoh94/Hpp Release 后继续安装。");
    if (!trusted) return;

    setInstallingOfficialAgentIds((prev) => ({ ...prev, [plugin.id]: true }));
    setPluginStatus(null);

    const installTask = officialInstallQueueRef.current.then(async () => {
      try {
        const result = await installOfficialPlugin(plugin.id);
        if (!result.success) {
          setPluginStatus({ type: "error", text: result.error || "官方插件安装失败" });
          return;
        }
        await applyInstalledPluginResult(result);
        setShowOfficialPluginModal(false);
        setPluginStatus({
          type: "success",
          text: `${result.agent?.name || plugin.name} ${result.replaced ? "已更新" : "已安装"}`,
        });
      } catch (error) {
        setPluginStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
      }
    });

    officialInstallQueueRef.current = installTask.catch(() => undefined);
    try {
      await installTask;
    } finally {
      setInstallingOfficialAgentIds((prev) => {
        const next = { ...prev };
        delete next[plugin.id];
        return next;
      });
    }
  }, [applyInstalledPluginResult, installOfficialPlugin]);

  const handleReloadPlugins = useCallback(async () => {
    setPluginStatus(null);
    const resultAgents = await reloadAgents();
    setPluginStatus({ type: "success", text: `已加载 ${resultAgents.length} 个 Agent` });
  }, [reloadAgents]);

  const handleReloadOfficialPlugins = useCallback(async () => {
    setPluginStatus(null);
    await loadOfficialPlugins(true);
  }, [loadOfficialPlugins]);

  const openRemovePluginConfirm = useCallback((agentId: string) => {
    setRemoveLocalRuntime(false);
    setRemoveConfirmAgentId(agentId);
  }, []);

  const closeRemovePluginConfirm = useCallback(() => {
    if (removingAgentId) return;
    setRemoveConfirmAgentId(null);
    setRemoveLocalRuntime(false);
  }, [removingAgentId]);

  const handleRemovePlugin = useCallback(async () => {
    const agentId = removeConfirmAgentId;
    if (!agentId) return;
    setRemovingAgentId(agentId);
    setPluginStatus(null);
    try {
      const result = await removePlugin(agentId, removeLocalRuntime);
      if (!result.success) {
        setPluginStatus({ type: "error", text: result.error || "插件卸载失败" });
        return;
      }
      delete cachedAgentStatuses[agentId];
      delete lastAgentChecks[agentId];
      const nextAgents = result.agents || agents.filter((agent) => agent.id !== agentId);
      const nextEnabledAgents = enabledAgents.filter((id) => id !== agentId);
      const nextAgentOrder = agentOrder.filter((id) => id !== agentId);
      setEnabledAgents(nextEnabledAgents);
      setAgentOrder(nextAgentOrder);
      setAgentStatuses((prev) => {
        const next = { ...prev };
        delete next[agentId];
        return next;
      });
      await saveAgentSettings(nextEnabledAgents, nextAgentOrder, nextAgents);
      setPluginStatus({
        type: "success",
        text: removeLocalRuntime ? "插件和本地 Agent 已卸载" : "插件已卸载",
      });
      setRemoveConfirmAgentId(null);
      setRemoveLocalRuntime(false);
    } catch (error) {
      setPluginStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRemovingAgentId("");
    }
  }, [agentOrder, agents, enabledAgents, removeConfirmAgentId, removeLocalRuntime, removePlugin, saveAgentSettings]);

  const orderedAgents = useMemo(() => orderAgents(agents, agentOrder), [agentOrder, agents]);
  const installedAgentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const content = (
    <>
      <div className="settings-section">
        {!embedded && (
          <div className="agent-settings-section-header">
            <h3>Agent 设置</h3>
            <button
              type="button"
              className="btn-icon agent-settings-config-icon"
              onClick={openAgentConfig}
              disabled={agents.length === 0}
              title="配置 Agent 渠道和模型"
              aria-label="配置 Agent 渠道和模型"
            >
              <Settings size={15} />
            </button>
          </div>
        )}
        <p className="section-desc">
          选择启用的 Agent，未启用的不会显示在项目卡片上。拖动左侧手柄可以调整显示顺序。
        </p>

        <div className="agent-plugin-entry-actions">
          <button
            type="button"
            className="filter-add-btn agent-plugin-entry-btn"
            onClick={() => {
              setPluginStatus(null);
              setShowLocalPluginModal(true);
            }}
          >
            <PackagePlus size={14} />
            本地安装
          </button>
          <button
            type="button"
            className="btn-action agent-plugin-entry-btn"
            onClick={() => {
              setPluginStatus(null);
              setShowOfficialPluginModal(true);
              void loadOfficialPlugins();
            }}
          >
            <Download size={14} />
            官方插件
          </button>
        </div>
        {pluginStatus && (
          <div className={`status-message ${pluginStatus.type}`}>
            {pluginStatus.text}
          </div>
        )}

        <div className="filter-group">
          {orderedAgents.map((agent) => {
            const hasNativePlanMode = supportsNativePlanMode(agent.id);
            const agentStatus = agentStatuses[agent.id];
            const isInstalled = agentStatus?.installed === true;
            const isChecking = agentChecking[agent.id] === true || !agentStatus;
            const isUnavailable = !isInstalled && !isChecking;
            const isInstallAction = agentStatus?.installed === false;
            const versionLabel = agentStatus?.currentVersion
              ? `v${agentStatus.currentVersion}`
              : isChecking
                ? "检查中..."
                : isInstalled
                  ? "版本未知"
                  : "未安装";

            return (
              <div
                key={agent.id}
                className={`filter-row agent-settings-row ${isUnavailable ? "agent-settings-row-disabled" : ""} ${draggingAgentId === agent.id ? "agent-settings-row-dragging" : ""} ${dragOverAgentId === agent.id && draggingAgentId !== agent.id ? "agent-settings-row-drop-target" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (draggingAgentId && draggingAgentId !== agent.id) setDragOverAgentId(agent.id);
                }}
                onDragLeave={() => setDragOverAgentId((current) => current === agent.id ? null : current)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggingAgentId) moveAgent(draggingAgentId, agent.id);
                  setDraggingAgentId(null);
                  setDragOverAgentId(null);
                }}
              >
                <button
                  type="button"
                  className="agent-settings-drag-handle"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", agent.id);
                    setDraggingAgentId(agent.id);
                  }}
                  onDragEnd={() => {
                    setDraggingAgentId(null);
                    setDragOverAgentId(null);
                  }}
                  title="拖动排序"
                >
                  <GripVertical size={14} />
                </button>

                <label className="agent-settings-main">
                  <input
                    type="checkbox"
                    checked={enabledAgents.includes(agent.id)}
                    disabled={!isInstalled || isChecking}
                    onChange={(event) => {
                      const nextEnabledAgents = event.target.checked
                        ? enabledAgents.includes(agent.id)
                          ? enabledAgents
                          : [...enabledAgents, agent.id]
                        : enabledAgents.filter((id) => id !== agent.id);
                      setEnabledAgents(nextEnabledAgents);
                      void saveAgentSettings(nextEnabledAgents, agentOrder);
                    }}
                    className="agent-settings-checkbox"
                  />
                  <span className="agent-settings-copy">
                    <span className="agent-settings-title-line">
                      <span className="agent-settings-name">{agent.name}</span>
                      <span className={`agent-settings-badge ${agentStatus?.updateAvailable ? "agent-settings-badge-warning" : ""}`}>
                        {versionLabel}
                      </span>
                      {isUnavailable && versionLabel !== "未安装" && (
                        <span className="agent-settings-badge agent-settings-badge-warning">
                          未安装
                        </span>
                      )}
                      {agentStatus?.latestVersion && (
                        <span className="agent-settings-meta">
                          最新 v{agentStatus.latestVersion}
                        </span>
                      )}
                      <span
                        className={`agent-settings-badge ${hasNativePlanMode ? "" : "agent-settings-badge-warning"}`}
                        title={getAgentPlanModeTooltip(agent.id)}
                      >
                        Plan
                      </span>
                    </span>
                    {(agentStatus?.error || agentUpdateErrors[agent.id]) && (
                      <span className="agent-settings-error">
                        {agentUpdateErrors[agent.id] || agentStatus?.error}
                      </span>
                    )}
                  </span>
                </label>

                <div className="agent-settings-actions">
                  {agentStatus && (isInstallAction || agentStatus.updateAvailable) && (
                    <button
                      className="filter-add-btn agent-settings-update-btn"
                      onClick={() => void handleAgentUpdate(agent.id)}
                      disabled={agentUpdating[agent.id] || !agentStatus.canUpdate}
                      title={agentStatus.canUpdate
                        ? isInstallAction ? "安装" : "更新"
                        : agentStatus.error || "请先安装 Node.js 和 npm"}
                    >
                      {agentUpdating[agent.id]
                        ? isInstallAction ? "安装中..." : "更新中..."
                        : isInstallAction ? "安装" : "更新"}
                    </button>
                  )}
                  {isInstalled && agent.removable && (
                    <button
                      className="btn-action agent-settings-refresh-btn"
                      onClick={() => openRemovePluginConfirm(agent.id)}
                      disabled={removingAgentId === agent.id}
                      title="卸载插件"
                    >
                      {removingAgentId === agent.id ? "卸载中..." : "卸载"}
                    </button>
                  )}
                  {isInstalled && (
                  <button
                    className="btn-action agent-settings-refresh-btn"
                    onClick={() => void refreshAgentStatus(agent.id)}
                    disabled={isChecking || agentUpdating[agent.id]}
                    title="重新检查版本"
                  >
                    {isChecking ? "检查中..." : "刷新"}
                  </button>
                  )}
                </div>
              </div>
            );
          })}

          {agents.length === 0 && (
            <p className="agent-settings-empty">未安装 Agent 插件。请选择插件 ZIP 或插件目录安装。</p>
          )}
        </div>
      </div>
    </>
  );

  const contentWithModal = (
    <>
      {content}
      {configAgent && (
        <AgentConfigModal
          agentId={configAgent.id}
          agentName={configAgent.name}
          onClose={() => setConfigAgentId(null)}
          onModelsUpdated={syncActiveAgentModels}
        />
      )}
      {showLocalPluginModal && (
        <div className="settings-modal-overlay" onClick={() => setShowLocalPluginModal(false)}>
          <div className="settings-modal agent-plugin-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>本地安装</h3>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setShowLocalPluginModal(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-modal-content">
              <div className="agent-plugin-toolbar agent-plugin-toolbar-modal">
                <input
                  value={pluginPath}
                  onChange={(event) => setPluginPath(event.target.value)}
                  className="input-field agent-plugin-path"
                  placeholder="Agent 插件目录或 ZIP 文件"
                />
                <button
                  type="button"
                  className="btn-action"
                  onClick={() => void handleChoosePluginPath("zip")}
                  title="选择 Agent 插件 ZIP"
                >
                  <FileArchive size={14} />
                  选择 ZIP
                </button>
                <button
                  type="button"
                  className="btn-action"
                  onClick={() => void handleChoosePluginPath("directory")}
                  title="选择解压后的 Agent 插件目录"
                >
                  <FolderOpen size={14} />
                  文件夹
                </button>
                <button
                  type="button"
                  className="filter-add-btn"
                  onClick={() => void handleInstallPlugin()}
                  disabled={installingPlugin}
                >
                  <PackagePlus size={14} />
                  {installingPlugin ? "安装中..." : "安装"}
                </button>
                <button
                  type="button"
                  className="btn-action"
                  onClick={() => void handleReloadPlugins()}
                  title="重新扫描已安装插件"
                >
                  <RefreshCw size={14} />
                  刷新
                </button>
              </div>
              {pluginStatus && (
                <div className={`status-message ${pluginStatus.type}`}>
                  {pluginStatus.text}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {showOfficialPluginModal && (
        <div className="settings-modal-overlay" onClick={() => setShowOfficialPluginModal(false)}>
          <div className="settings-modal agent-plugin-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div className="settings-modal-title-actions">
                <h3>官方插件</h3>
                <button
                  type="button"
                  className="btn-icon settings-modal-header-icon"
                  onClick={() => void handleReloadOfficialPlugins()}
                  disabled={officialLoading}
                  title="刷新官方插件"
                  aria-label="刷新官方插件"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setShowOfficialPluginModal(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-modal-content">
              {officialError && (
                <div className="status-message error">
                  {officialError}
                </div>
              )}
              {pluginStatus && (
                <div className={`status-message ${pluginStatus.type}`}>
                  {pluginStatus.text}
                </div>
              )}
              <div className="agent-official-list">
                {officialPlugins.map((plugin) => {
                  const installedAgent = installedAgentById.get(plugin.id);
                  const installed = !!installedAgent;
                  const updateAvailable = installed && compareVersions(plugin.version, installedAgent.version) > 0;
                  const installing = installingOfficialAgentIds[plugin.id] === true;
                  const buttonText = installing
                    ? "安装中..."
                    : !installed
                      ? "安装"
                      : updateAvailable
                        ? "更新"
                        : "已安装";

                  return (
                    <div key={plugin.id} className="agent-official-row">
                      <div className="agent-official-main">
                        <div className="agent-settings-title-line">
                          <span className="agent-settings-name">{plugin.name}</span>
                          <span className="agent-settings-badge">v{plugin.version}</span>
                          <span className={`agent-settings-badge ${updateAvailable || !installed ? "agent-settings-badge-warning" : ""}`}>
                            {!installed ? "未安装" : updateAvailable ? "可更新" : "已安装"}
                          </span>
                        </div>
                        {plugin.description && (
                          <div className="agent-settings-meta">{plugin.description}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        className={installed && !updateAvailable ? "btn-action agent-settings-refresh-btn" : "filter-add-btn agent-settings-update-btn"}
                        onClick={() => void handleInstallOfficialPlugin(plugin)}
                        disabled={officialLoading || installing || (installed && !updateAvailable)}
                      >
                        {buttonText}
                      </button>
                    </div>
                  );
                })}

                {officialLoading && officialPlugins.length === 0 && (
                  <p className="agent-settings-empty">加载中...</p>
                )}
                {!officialLoading && !officialError && officialPlugins.length === 0 && (
                  <p className="agent-settings-empty">暂无官方插件。</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {removeConfirmAgentId && (
        <div className="settings-modal-overlay" onClick={closeRemovePluginConfirm}>
          <div className="settings-modal agent-remove-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>卸载 Agent 插件</h3>
              <button
                type="button"
                className="settings-modal-close"
                onClick={closeRemovePluginConfirm}
                disabled={!!removingAgentId}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-modal-content agent-remove-confirm-content">
              <p>
                确定要卸载 {agents.find((agent) => agent.id === removeConfirmAgentId)?.name || removeConfirmAgentId} 插件吗？
              </p>
              <label className="settings-toggle-row agent-remove-runtime-toggle">
                <span>
                  <span className="settings-toggle-title">同时卸载本地安装的 Agent</span>
                  <span className="settings-toggle-desc">关闭时只删除 Hpp 插件，保留本地运行时。</span>
                </span>
                <input
                  type="checkbox"
                  checked={removeLocalRuntime}
                  onChange={(event) => setRemoveLocalRuntime(event.target.checked)}
                  disabled={!!removingAgentId}
                />
              </label>
              <div className="agent-remove-confirm-actions">
                <button type="button" className="btn-action" onClick={closeRemovePluginConfirm} disabled={!!removingAgentId}>
                  取消
                </button>
                <button type="button" className="filter-add-btn" onClick={() => void handleRemovePlugin()} disabled={!!removingAgentId}>
                  {removingAgentId ? "卸载中..." : "确认卸载"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div className="agent-settings-panel">{contentWithModal}</div>;
  }

  return (
    <div className="settings agent-settings-panel">
      <div className="settings-header">Agent</div>
      <div className="settings-content">{contentWithModal}</div>
    </div>
  );
}
