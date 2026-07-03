import { useCallback, useEffect, useState } from "react";
import { GripVertical } from "lucide-react";
import {
  AVAILABLE_AGENTS,
  getAgentPlanModeTooltip,
  normalizeAgentOrder,
  orderAgents,
  supportsNativePlanMode,
} from "@/lib/agents";
import type { AgentPackageStatus, PiSDKStatus } from "@/types";
import "./Settings.css";

const DEFAULT_ENABLED_AGENTS = ["codex", "pi"];
const AGENT_SETTINGS_UPDATED_EVENT = "agent-settings-updated";

// === Module-level version check cache (persists across mounts) ===
let cachedPiSDKStatus: PiSDKStatus | null = null;
let cachedAgentStatuses: Record<string, AgentPackageStatus> = {};
let lastPiSDKCheck = 0;
let lastAgentChecks: Record<string, number> = {};
const VERSION_CACHE_MS = 60_000; // 1 minute

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

interface AgentSettingsViewProps {
  embedded?: boolean;
}

export function AgentSettingsView({ embedded = false }: AgentSettingsViewProps) {
  const [enabledAgents, setEnabledAgents] = useState<string[]>(DEFAULT_ENABLED_AGENTS);
  const [agentOrder, setAgentOrder] = useState<string[]>(normalizeAgentOrder());
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);
  const [piSDKStatus, setPiSDKStatus] = useState<PiSDKStatus | null>(null);
  const [piSDKChecking, setPiSDKChecking] = useState(false);
  const [piSDKUpdating, setPiSDKUpdating] = useState(false);
  const [piSDKUpdateError, setPiSDKUpdateError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentPackageStatus>>({});
  const [agentChecking, setAgentChecking] = useState<Record<string, boolean>>({});
  const [agentUpdating, setAgentUpdating] = useState<Record<string, boolean>>({});
  const [agentUpdateErrors, setAgentUpdateErrors] = useState<Record<string, string>>({});

  const refreshPiSDKStatus = useCallback(async () => {
    setPiSDKChecking(true);
    try {
      const status = await window.electronAPI.piSDKGetStatus();
      cachedPiSDKStatus = status;
      lastPiSDKCheck = Date.now();
      setPiSDKStatus(status);
      setPiSDKUpdateError(null);
    } catch (error) {
      cachedPiSDKStatus = null;
      setPiSDKStatus({
        installed: false,
        updateAvailable: false,
        canUpdate: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPiSDKChecking(false);
    }
  }, []);

  const handlePiSDKUpdate = useCallback(async () => {
    setPiSDKUpdating(true);
    setPiSDKUpdateError(null);
    try {
      const result = await window.electronAPI.piSDKUpdate();
      if (result.status) {
        cachedPiSDKStatus = result.status;
        lastPiSDKCheck = Date.now();
        setPiSDKStatus(result.status);
      }
      if (!result.success) {
        setPiSDKUpdateError(result.error || "Pi SDK 更新失败");
      }
    } catch (error) {
      setPiSDKUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setPiSDKUpdating(false);
    }
  }, []);

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
        const status = result.status;
        cachedAgentStatuses[agentId] = status;
        lastAgentChecks[agentId] = Date.now();
        setAgentStatuses((prev) => ({ ...prev, [agentId]: status }));
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

  const saveAgentSettings = useCallback(async (
    nextEnabledAgents = enabledAgents,
    nextAgentOrder = agentOrder,
  ) => {
    const settings = await loadSettings();
    const general = asRecord(settings.general);
    const normalizedOrder = normalizeAgentOrder(nextAgentOrder);
    const nextSettings = {
      ...settings,
      general: {
        ...general,
        enabledAgents: nextEnabledAgents,
        agentOrder: normalizedOrder,
      },
    };

    await window.electronAPI.saveData("settings", nextSettings);
    window.dispatchEvent(new CustomEvent(AGENT_SETTINGS_UPDATED_EVENT, {
      detail: {
        enabledAgents: nextEnabledAgents,
        agentOrder: normalizedOrder,
        planModeEnabled: typeof general.planModeEnabled === "boolean" ? general.planModeEnabled : undefined,
      },
    }));
  }, [enabledAgents, agentOrder]);

  const moveAgent = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const currentOrder = normalizeAgentOrder(agentOrder);
    const fromIndex = currentOrder.indexOf(sourceId);
    const toIndex = currentOrder.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setAgentOrder(nextOrder);
    void saveAgentSettings(enabledAgents, nextOrder);
  }, [agentOrder, enabledAgents, saveAgentSettings]);

  useEffect(() => {
    let cancelled = false;

    loadSettings().then((settings) => {
      if (cancelled) return;
      const general = asRecord(settings.general);
      setEnabledAgents(getStringArray(general.enabledAgents) ?? DEFAULT_ENABLED_AGENTS);
      setAgentOrder(normalizeAgentOrder(getStringArray(general.agentOrder)));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleAgentSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ enabledAgents?: string[]; agentOrder?: string[] }>).detail;
      if (Array.isArray(detail?.enabledAgents)) setEnabledAgents(detail.enabledAgents);
      if (detail?.agentOrder) setAgentOrder(normalizeAgentOrder(detail.agentOrder));
    };
    window.addEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
    return () => window.removeEventListener(AGENT_SETTINGS_UPDATED_EVENT, handleAgentSettingsUpdated);
  }, []);

  // Check agent package status (with 1-minute cache)
  useEffect(() => {
    const now = Date.now();

    if (now - lastPiSDKCheck > VERSION_CACHE_MS) {
      void refreshPiSDKStatus();
    } else if (cachedPiSDKStatus) {
      setPiSDKStatus(cachedPiSDKStatus);
    }

    for (const agent of AVAILABLE_AGENTS) {
      if (agent.id === "pi") continue;
      if (now - (lastAgentChecks[agent.id] || 0) > VERSION_CACHE_MS) {
        void refreshAgentStatus(agent.id);
      } else if (cachedAgentStatuses[agent.id]) {
        setAgentStatuses((prev) => ({ ...prev, [agent.id]: cachedAgentStatuses[agent.id]! }));
      }
    }
  }, [refreshPiSDKStatus, refreshAgentStatus]);

  const content = (
    <>
        <div className="settings-section">
          {!embedded && <h3>Agent 设置</h3>}
          <p className="section-desc">
            选择启用的 Agent，未启用的不会显示在项目卡片上。拖动左侧手柄可以调整显示顺序。
          </p>

          <div className="filter-group">
            {orderAgents(AVAILABLE_AGENTS, agentOrder).map((agent) => {
              const isPiSDKAgent = agent.id === "pi";
              const hasNativePlanMode = supportsNativePlanMode(agent.id);
              const agentStatus = agentStatuses[agent.id];
              const isInstalled = isPiSDKAgent
                ? piSDKStatus?.installed === true
                : agentStatus?.installed === true;
              const isChecking = isPiSDKAgent
                ? (piSDKChecking || !piSDKStatus)
                : agentChecking[agent.id];
              const isUnavailable = !isInstalled && !isChecking;
              const versionLabel = isPiSDKAgent
                ? piSDKStatus?.currentVersion
                  ? `v${piSDKStatus.currentVersion}`
                  : isChecking
                    ? "检查中..."
                    : isInstalled
                      ? "版本未知"
                      : "未安装"
                : agentStatus?.currentVersion
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
                        <span className={`agent-settings-badge ${(isPiSDKAgent ? piSDKStatus?.updateAvailable : agentStatus?.updateAvailable) ? "agent-settings-badge-warning" : ""}`}>
                          {versionLabel}
                        </span>
                        {isUnavailable && versionLabel !== "未安装" && (
                          <span className="agent-settings-badge agent-settings-badge-warning">
                            未安装
                          </span>
                        )}
                        {(isPiSDKAgent ? piSDKStatus?.latestVersion : agentStatus?.latestVersion) && (
                          <span className="agent-settings-meta">
                            最新 v{isPiSDKAgent ? piSDKStatus?.latestVersion : agentStatus?.latestVersion}
                          </span>
                        )}
                        <span
                          className={`agent-settings-badge ${hasNativePlanMode ? "" : "agent-settings-badge-warning"}`}
                          title={getAgentPlanModeTooltip(agent.id)}
                        >
                          Plan
                        </span>
                      </span>
                      {isPiSDKAgent && piSDKStatus?.nodeVersion && piSDKStatus.nodeOk === false && (
                        <span className="agent-settings-error">
                          Node v{piSDKStatus.nodeVersion} 过低，需要 22.19.0 或更高版本
                        </span>
                      )}
                      {(isPiSDKAgent ? (piSDKStatus?.error || piSDKUpdateError) : (agentStatus?.error || agentUpdateErrors[agent.id])) && (
                        <span className="agent-settings-error">
                          {isPiSDKAgent ? (piSDKUpdateError || piSDKStatus?.error) : (agentUpdateErrors[agent.id] || agentStatus?.error)}
                        </span>
                      )}
                    </span>
                  </label>

                  <div className="agent-settings-actions">
                    {((isPiSDKAgent && piSDKStatus?.updateAvailable) || (!isPiSDKAgent && agentStatus?.updateAvailable)) && (
                      <button
                        className="filter-add-btn agent-settings-update-btn"
                        onClick={() => isPiSDKAgent ? void handlePiSDKUpdate() : void handleAgentUpdate(agent.id)}
                        disabled={(isPiSDKAgent ? piSDKUpdating : agentUpdating[agent.id]) || !(isPiSDKAgent ? piSDKStatus?.canUpdate : agentStatus?.canUpdate)}
                        title={(isPiSDKAgent ? piSDKStatus?.canUpdate : agentStatus?.canUpdate) ? "更新" : "当前环境不支持自动更新"}
                      >
                        {(isPiSDKAgent ? piSDKUpdating : agentUpdating[agent.id]) ? "更新中..." : "更新"}
                      </button>
                    )}
                    <button
                      className="btn-action agent-settings-refresh-btn"
                      onClick={() => isPiSDKAgent ? void refreshPiSDKStatus() : void refreshAgentStatus(agent.id)}
                      disabled={isChecking || (isPiSDKAgent ? piSDKUpdating : agentUpdating[agent.id])}
                      title="重新检查版本"
                    >
                      {isChecking ? "检查中..." : "刷新"}
                    </button>
                  </div>
                </div>
              );
            })}

            {AVAILABLE_AGENTS.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>暂无可用 Agent</p>
            )}
          </div>
        </div>
    </>
  );

  if (embedded) {
    return <div className="agent-settings-panel">{content}</div>;
  }

  return (
    <div className="settings agent-settings-panel">
      <div className="settings-header">Agent</div>
      <div className="settings-content">{content}</div>
    </div>
  );
}
