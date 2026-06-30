import { useState, useEffect, useCallback } from "react";
import { AVAILABLE_AGENTS } from "@/lib/agents";
import type { AgentPackageStatus, PiSDKStatus } from "@/types";
import "./Settings.css";

interface ShortcutConfig {
  sendKey: string;
  fileSearch: string;
  switchToFiles: string;
  prevModel: string;
  nextModel: string;
}

interface FilterConfig {
  excludeFolders: string[];
  excludeExtensions: string[];
  excludeFiles: string[];
}

const SHORTCUT_LABELS: Record<string, string> = {
  fileSearch: "文件搜索",
  switchToFiles: "切换到资源管理器",
  prevModel: "上一个模型",
  nextModel: "下一个模型",
};

const DEFAULT_SHORTCUTS: ShortcutConfig = {
  sendKey: "Enter",
  fileSearch: "Ctrl+P",
  switchToFiles: "Ctrl+Shift+F",
  prevModel: "Ctrl+[",
  nextModel: "Ctrl+]",
};

const DEFAULT_FILTERS: FilterConfig = {
  excludeFolders: ["node_modules", ".git", "dist"],
  excludeExtensions: [".pyc", ".class"],
  excludeFiles: [".env"],
};

function formatKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Cmd");

  const key = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  if (key === " ") parts.push("Space");
  else if (key === "Enter") parts.push("Enter");
  else if (key === "Backspace") parts.push("Backspace");
  else if (key === "Escape") parts.push("Esc");
  else if (key === "ArrowUp") parts.push("Up");
  else if (key === "ArrowDown") parts.push("Down");
  else if (key === "ArrowLeft") parts.push("Left");
  else if (key === "ArrowRight") parts.push("Right");
  else if (key === "Tab") parts.push("Tab");
  else if (key === "<") parts.push("<");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join("+");
}

export function SettingsView() {
  const [shortcuts, setShortcuts] = useState<ShortcutConfig>(DEFAULT_SHORTCUTS);
  const [filters, setFilters] = useState<FilterConfig>(DEFAULT_FILTERS);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [showShortcutModal, setShowShortcutModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showGeneralModal, setShowGeneralModal] = useState(false);
  const [tempImagePath, setTempImagePath] = useState("");
  const [imageRetentionHours, setImageRetentionHours] = useState(12);
  const [enabledAgents, setEnabledAgents] = useState<string[]>(["pi"]);
  const [piSDKStatus, setPiSDKStatus] = useState<PiSDKStatus | null>(null);
  const [piSDKChecking, setPiSDKChecking] = useState(false);
  const [piSDKUpdating, setPiSDKUpdating] = useState(false);
  const [piSDKUpdateError, setPiSDKUpdateError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentPackageStatus>>({});
  const [agentChecking, setAgentChecking] = useState<Record<string, boolean>>({});
  const [agentUpdating, setAgentUpdating] = useState<Record<string, boolean>>({});
  const [agentUpdateErrors, setAgentUpdateErrors] = useState<Record<string, string>>({});
  const [newFolder, setNewFolder] = useState("");
  const [newExt, setNewExt] = useState("");
  const [newFile, setNewFile] = useState("");

  const refreshPiSDKStatus = useCallback(async () => {
    setPiSDKChecking(true);
    try {
      const status = await window.electronAPI.piSDKGetStatus();
      setPiSDKStatus(status);
      setPiSDKUpdateError(null);
    } catch (error) {
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
      if (result.status) setPiSDKStatus(result.status);
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
      setAgentStatuses((prev) => ({ ...prev, [agentId]: status }));
      setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: "" }));
    } catch (error) {
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
      if (result.status) setAgentStatuses((prev) => ({ ...prev, [agentId]: result.status }));
      if (!result.success) {
        setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: result.error || "更新失败" }));
      }
    } catch (error) {
      setAgentUpdateErrors((prev) => ({ ...prev, [agentId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setAgentUpdating((prev) => ({ ...prev, [agentId]: false }));
    }
  }, []);

  // Load saved settings on mount
  useEffect(() => {
    window.electronAPI.loadData("settings").then((data: any) => {
      if (data) {
        if (data.shortcuts) {
          // Filter out deprecated keys like cycleModel
          const { cycleModel, ...rest } = data.shortcuts;
          setShortcuts({ ...DEFAULT_SHORTCUTS, ...rest });
        }
        if (data.filters) setFilters({ ...DEFAULT_FILTERS, ...data.filters });
        if (data.general) {
          setTempImagePath(data.general.tempImagePath || "");
          setImageRetentionHours(data.general.imageRetentionHours || 12);
          if (data.general.enabledAgents) setEnabledAgents(data.general.enabledAgents);
        }
      }
    });
  }, []);

  // Check agent package status
  useEffect(() => {
    refreshPiSDKStatus();

    // Check status for other agents
    for (const agent of AVAILABLE_AGENTS) {
      if (agent.id === "pi") continue;
      refreshAgentStatus(agent.id);
    }
  }, [refreshPiSDKStatus, refreshAgentStatus]);

  // Save shortcuts when changed
  const saveShortcuts = (s: ShortcutConfig) => {
    setShortcuts(s);
    window.electronAPI.saveData("settings", { shortcuts: s, filters, general: { tempImagePath, imageRetentionHours, enabledAgents } });
  };

  const saveFilters = (f: FilterConfig) => {
    setFilters(f);
    window.electronAPI.saveData("settings", { shortcuts, filters: f, general: { tempImagePath, imageRetentionHours, enabledAgents } });
  };

  const saveGeneral = () => {
    window.electronAPI.saveData("settings", { shortcuts, filters, general: { tempImagePath, imageRetentionHours, enabledAgents } });
  };

  // Keyboard recording handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!recordingKey) return;
    e.preventDefault();
    e.stopPropagation();

    const combo = formatKey(e);
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

  return (
    <div className="settings">
      <div className="settings-header">设置</div>

      <div className="settings-content">
        <div className="settings-section">
          <h3>快速操作</h3>
          <div className="settings-quick-buttons">
            <button
              onClick={() => { setShowShortcutModal(true); setRecordingKey(null); }}
              className="btn-quick-setting"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M19.4 15a2 2 0 00.4 2.2l.1.1a2 2 0 01-2.8 2.8l-.1-.1a2 2 0 00-2.2-.4 2 2 0 00-1.2 1.2v.1a2 2 0 01-4 0v-.1a2 2 0 00-1.1-1.1 2 2 0 00-2.2.4l-.1.1a2 2 0 01-2.8-2.8l.1-.1a2 2 0 00.4-2.2 2 2 0 00-1.2-1.2h-.1a2 2 0 01 0-4h.1A2 2 0 004.6 9a2 2 0 00-.4-2.2l-.1-.1a2 2 0 012.8-2.8l.1.1a2 2 0 002.2.4h.1a2 2 0 001.1-1.1v-.1a2 2 0 014 0v.1a2 2 0 001.1 1.1h.1a2 2 0 002.2-.4l.1-.1a2 2 0 012.8 2.8l-.1.1a2 2 0 00-.4 2.2v.1a2 2 0 001.2 1.2h.1a2 2 0 010 4h-.1a2 2 0 00-1.2 1.2z" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              快捷键设置
            </button>

            <button
              onClick={() => setShowFilterModal(true)}
              className="btn-quick-setting"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707L14 14v7a1 1 0 01-1 1h-2a1 1 0 01-1-1v-7L3.293 7.293A1 1 0 013 6.586V4z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              过滤规则
            </button>
            <button
              onClick={() => setShowGeneralModal(true)}
              className="btn-quick-setting"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              通用设置
            </button>
          </div>
        </div>
      </div>

      {showShortcutModal && (
        <div className="settings-modal-overlay" onClick={() => { setShowShortcutModal(false); setRecordingKey(null); }}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>快捷键设置</h3>
              <button onClick={() => { setShowShortcutModal(false); setRecordingKey(null); }} className="settings-modal-close">×</button>
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
                {Object.entries(shortcuts).filter(([k]) => k !== "sendKey" && k !== "prevModel" && k !== "nextModel").map(([key, value]) => {
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
              </div>
              <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 12 }}>
                点击快捷键按钮后，按下新的组合键即可设置。按 Esc 取消。
              </p>
            </div>
          </div>
        </div>
      )}

      {showFilterModal && (
        <div className="settings-modal-overlay" onClick={() => setShowFilterModal(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>过滤规则</h3>
              <button onClick={() => setShowFilterModal(false)} className="settings-modal-close">×</button>
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
      {showGeneralModal && (
        <div className="settings-modal-overlay" onClick={() => setShowGeneralModal(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h3>通用设置</h3>
              <button onClick={() => setShowGeneralModal(false)} className="settings-modal-close">×</button>
            </div>
            <div className="settings-modal-content">
              <div className="settings-section">
                <h3>Agent 设置</h3>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
                  选择启用的 Agent，未启用的不会显示在项目卡片上
                </p>
                <div className="filter-group">
                  {AVAILABLE_AGENTS.map((agent) => {
                    const isPiSDKAgent = agent.id === "pi";
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
                    <div key={agent.id} className={`filter-row agent-settings-row ${isUnavailable ? "agent-settings-row-disabled" : ""}`}>
                      <label className="agent-settings-main">
                        <input
                          type="checkbox"
                          checked={enabledAgents.includes(agent.id)}
                          disabled={!isInstalled || isChecking}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setEnabledAgents((prev) => prev.includes(agent.id) ? prev : [...prev, agent.id]);
                            } else {
                              setEnabledAgents((prev) => prev.filter((id) => id !== agent.id));
                            }
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
                            onClick={() => isPiSDKAgent ? handlePiSDKUpdate() : handleAgentUpdate(agent.id)}
                            disabled={(isPiSDKAgent ? piSDKUpdating : agentUpdating[agent.id]) || !(isPiSDKAgent ? piSDKStatus?.canUpdate : agentStatus?.canUpdate)}
                            title={(isPiSDKAgent ? piSDKStatus?.canUpdate : agentStatus?.canUpdate) ? "更新" : "当前环境不支持自动更新"}
                          >
                            {(isPiSDKAgent ? piSDKUpdating : agentUpdating[agent.id]) ? "更新中..." : "更新"}
                          </button>
                        )}
                        <button
                          className="btn-action agent-settings-refresh-btn"
                          onClick={() => isPiSDKAgent ? refreshPiSDKStatus() : refreshAgentStatus(agent.id)}
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
              <div className="settings-section" style={{ marginTop: 16 }}>
                <h3>图片设置</h3>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
                  临时图片将在指定时间后自动清理
                </p>
                <div className="filter-group">
                  <div className="filter-row">
                    <label>临时图片存储路径</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        value={tempImagePath}
                        onChange={(e) => setTempImagePath(e.target.value)}
                        placeholder="留空使用默认路径"
                        className="filter-custom-input"
                        style={{ flex: 1 }}
                      />
                      <button
                        className="filter-add-btn"
                        onClick={async () => {
                          const result = await (window as any).electronAPI.openDirectory();
                          if (!result.canceled && result.path) {
                            setTempImagePath(result.path);
                          }
                        }}
                        title="选择文件夹"
                      >
                        浏览
                      </button>
                    </div>
                  </div>
                  <div className="filter-row">
                    <label>图片保留时间（小时）</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="number"
                        min={1}
                        max={168}
                        value={imageRetentionHours}
                        onChange={(e) => setImageRetentionHours(parseInt(e.target.value) || 12)}
                        className="filter-custom-input"
                        style={{ width: 80 }}
                      />
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>小时</span>
                    </div>
                  </div>
                </div>
                <button
                  className="filter-add-btn"
                  style={{ marginTop: 12 }}
                  onClick={() => { saveGeneral(); setShowGeneralModal(false); }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
