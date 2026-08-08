import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Save,
  Upload,
  X,
} from "lucide-react";
import type {
  AgentConfigState,
  AgentProviderConfig,
} from "@/types";
import { getAgentName } from "@/lib/agents";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { createCopiedProviderId } from "@shared/agent-provider-copy";
import {
  createAgentConfigExportData,
  isValidAgentConfigExport,
  resolveImportProviderId,
  sanitizeAgentConfigExport,
  type AgentConfigExportData,
  type AgentConfigImportConflictPlan,
} from "@shared/agent-config-io";
import "./Settings.css";

function cloneProvider(provider: AgentProviderConfig): AgentProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}

function downloadAgentConfigExportFallback(data: AgentConfigExportData) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hpp-agent-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Cross-agent import/export of channel (provider) configurations.
 * The entry point is rendered in the Agent configuration title bar because
 * an export is a bundle that can span many agents, not a per-channel action.
 */
export function AgentConfigIO() {
  const agents = useAgentCatalogStore((state) => state.agents);

  const configurableAgents = useMemo(
    () => agents.filter((agent) => agent.capabilities.configuration !== "none"),
    [agents]
  );

  // ---- Export state ----
  const [exportOpen, setExportOpen] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportIncludeApiKeys, setExportIncludeApiKeys] = useState(true);
  const [exportAgentConfigs, setExportAgentConfigs] = useState<Record<string, AgentConfigState>>({});
  const [exportSelections, setExportSelections] = useState<Record<string, Record<string, boolean>>>({});
  const [exportExpanded, setExportExpanded] = useState<Record<string, boolean>>({});
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);

  // ---- Import state ----
  const [importOpen, setImportOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importData, setImportData] = useState<AgentConfigExportData | null>(null);
  const [importTargetConfigs, setImportTargetConfigs] = useState<Record<string, AgentConfigState>>({});
  const [importDecisions, setImportDecisions] = useState<Record<string, Record<string, AgentConfigImportConflictPlan>>>({});
  const [importExpanded, setImportExpanded] = useState<Record<string, boolean>>({});
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const handleOpenExport = useCallback(async () => {
    setExportError("");
    setExportOpen(true);
    setExportLoading(true);
    setExportIncludeApiKeys(true);
    const collected: Record<string, AgentConfigState> = {};
    const selections: Record<string, Record<string, boolean>> = {};
    const expanded: Record<string, boolean> = {};
    try {
      for (const agent of configurableAgents) {
        try {
          const result = await window.electronAPI.agentConfigList(agent.id);
          if (!result.success || !result.config) continue;
          if (result.config.providers.length === 0) continue; // nothing to export
          collected[agent.id] = result.config;
          const agentSel: Record<string, boolean> = {};
          for (const provider of result.config.providers) {
            agentSel[provider.providerId] = true;
          }
          selections[agent.id] = agentSel;
          // Default collapsed so the list doesn't open every channel at once.
          expanded[agent.id] = false;
        } catch {
          // skip agents that fail to load
        }
      }
      setExportAgentConfigs(collected);
      setExportSelections(selections);
      setExportExpanded(expanded);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportLoading(false);
    }
  }, [configurableAgents]);

  const prepareImportData = useCallback(async (data: AgentConfigExportData) => {
    const targets: Record<string, AgentConfigState> = {};
    const expanded: Record<string, boolean> = {};
    for (const agentId of Object.keys(data.agents)) {
      const targetAgent = configurableAgents.find((agent) => agent.id === agentId);
      if (!targetAgent) continue;
      try {
        const result = await window.electronAPI.agentConfigList(agentId);
        targets[agentId] = result.success && result.config ? result.config : { providers: [] };
      } catch {
        targets[agentId] = { providers: [] };
      }
      // Default collapsed
      expanded[agentId] = false;
    }
    setImportTargetConfigs(targets);
    setImportExpanded(expanded);
    setImportData(data);
  }, [configurableAgents]);

  const handleImportFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImportError("");
    setImportOpen(true);
    setImportLoading(true);
    setImportData(null);
    setImportDecisions({});
    try {
      const parsed: unknown = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      if (!isValidAgentConfigExport(parsed)) {
        setImportError("导入文件不是有效的 HPP 渠道配置导出文件。");
        return;
      }
      await prepareImportData(parsed);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入文件不是有效的 JSON。");
    } finally {
      setImportLoading(false);
    }
  }, [prepareImportData]);

  const handleOpenImport = useCallback(async () => {
    setImportError("");
    setImportData(null);
    setImportDecisions({});

    // Older running preload versions do not expose the new IPC method yet.
    // Fall back to a regular file input so import still works without a crash.
    if (typeof window.electronAPI.agentConfigImportRead !== "function") {
      setImportOpen(false);
      setImportLoading(false);
      importFileInputRef.current?.click();
      return;
    }

    setImportOpen(true);
    setImportLoading(true);
    try {
      const readResult = await window.electronAPI.agentConfigImportRead();
      if (!readResult.success || !readResult.data) {
        if (!readResult.canceled) {
          setImportError(readResult.error || "读取导入文件失败");
        }
        return;
      }
      await prepareImportData(readResult.data);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportLoading(false);
    }
  }, [prepareImportData]);

  const handleExportSubmit = useCallback(async () => {
    setExportError("");
    const agents: Record<string, { activeProviderId?: string; providers: AgentProviderConfig[] }> = {};
    for (const agentId of Object.keys(exportSelections)) {
      const selection = exportSelections[agentId];
      const configState = exportAgentConfigs[agentId];
      if (!configState) continue;
      const selectedIds = Object.keys(selection).filter((id) => selection[id]);
      if (selectedIds.length === 0) continue;
      const providers = configState.providers
        .filter((provider) => selectedIds.includes(provider.providerId))
        .map((provider) => cloneProvider(provider));
      if (providers.length === 0) continue;
      agents[agentId] = {
        activeProviderId:
          configState.activeProviderId && selectedIds.includes(configState.activeProviderId)
            ? configState.activeProviderId
            : undefined,
        providers,
      };
    }
    if (Object.keys(agents).length === 0) {
      setExportError("请至少选择一个渠道。");
      return;
    }
    const data = sanitizeAgentConfigExport(
      createAgentConfigExportData(agents, exportIncludeApiKeys),
      exportIncludeApiKeys,
    );
    setExporting(true);
    try {
      if (typeof window.electronAPI.agentConfigExport !== "function") {
        downloadAgentConfigExportFallback(data);
        setExportOpen(false);
        return;
      }
      const result = await window.electronAPI.agentConfigExport(data);
      if (!result.success) {
        if (!result.canceled) setExportError(result.error || "导出失败");
        return;
      }
      setExportOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }, [exportAgentConfigs, exportSelections, exportIncludeApiKeys]);

  const handleApplyImport = useCallback(async () => {
    if (!importData) return;
    setImporting(true);
    setImportError("");
    const failed: string[] = [];
    try {
      for (const agentId of Object.keys(importData.agents)) {
        const entry = importData.agents[agentId];
        const targetConfig = importTargetConfigs[agentId];
        const targetAgent = configurableAgents.find((agent) => agent.id === agentId);
        if (!targetAgent) continue; // agent not installed/available
        const targetProviderIds = targetConfig?.providers.map((provider) => provider.providerId) || [];
        const agentDecisions = importDecisions[agentId] || {};
        for (const incoming of entry.providers) {
          const plan = agentDecisions[incoming.providerId];
          const resolved = resolveImportProviderId(incoming, targetProviderIds, plan);
          if (resolved.action === "skip") continue;
          const nextProvider = { ...cloneProvider(incoming), providerId: resolved.providerId };
          // Import files without keys keep the key of an existing same-id channel.
          if (!nextProvider.apiKey) {
            const existingProvider = targetConfig?.providers.find(
              (provider) => provider.providerId === resolved.providerId,
            );
            if (existingProvider?.apiKey) nextProvider.apiKey = existingProvider.apiKey;
          }
          try {
            if (!nextProvider.baseUrl) {
              failed.push(`${agentId}/${incoming.providerId}: 缺失渠道 URL`);
              continue;
            }
            const result = await window.electronAPI.agentConfigSave(agentId, nextProvider);
            if (!result.success) {
              failed.push(`${agentId}/${incoming.providerId}: ${result.error || "保存失败"}`);
            }
          } catch (error) {
            failed.push(`${agentId}/${incoming.providerId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (failed.length > 0) {
        setImportError(`部分渠道导入失败：\n${failed.join("\n")}`);
      } else {
        setImportOpen(false);
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }, [importData, importTargetConfigs, importDecisions, configurableAgents]);

  const toggleExportAgent = (agentId: string) => {
    const selection = exportSelections[agentId];
    if (!selection) return;
    const allSelected = Object.values(selection).every(Boolean);
    const nextSelection: Record<string, boolean> = {};
    for (const providerId of Object.keys(selection)) {
      nextSelection[providerId] = !allSelected;
    }
    setExportSelections((prev) => ({ ...prev, [agentId]: nextSelection }));
  };

  const anyExportSelected = useMemo(
    () => Object.values(exportSelections).some((selection) => Object.values(selection).some(Boolean)),
    [exportSelections]
  );
  const exportSelectedCount = useMemo(
    () => Object.values(exportSelections).reduce(
      (total, selection) => total + Object.values(selection).filter(Boolean).length,
      0,
    ),
    [exportSelections]
  );

  return (
    <>
      <input
        ref={importFileInputRef}
        className="agent-config-io-file-input"
        type="file"
        accept=".json,application/json"
        onChange={(event) => void handleImportFileChange(event)}
      />
      <div className="agent-config-io-entry-actions">
        <button
          type="button"
          className="btn-action agent-config-io-entry-btn"
          onClick={() => void handleOpenExport()}
          title="导出所选 Agent 的渠道配置到 JSON 文件"
        >
          <Upload size={14} />
          导出
        </button>
        <button
          type="button"
          className="btn-action agent-config-io-entry-btn"
          onClick={() => void handleOpenImport()}
          title="从 JSON 文件导入渠道配置"
        >
          <Download size={14} />
          导入
        </button>
      </div>

      {exportOpen && (
        <div className="settings-modal-overlay agent-config-io-overlay" onMouseDown={() => setExportOpen(false)}>
          <div className="settings-modal agent-config-io-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>导出渠道配置</h3>
                <div className="agent-config-subtitle">选择要导出的 Agent 渠道（跨 Agent 配置包）</div>
              </div>
              <button type="button" className="settings-modal-close" onClick={() => setExportOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="settings-modal-content agent-config-io-content">
              {exportLoading ? (
                <div className="agent-config-empty">正在收集配置...</div>
              ) : (
                <>
                  <div className="agent-config-io-overview">
                    <div>
                      <strong>选择要迁移的渠道</strong>
                      <span>{Object.keys(exportAgentConfigs).length} 个 Agent · 已选 {exportSelectedCount} 个渠道</span>
                    </div>
                    <span className="agent-config-io-overview-hint">点击 Agent 展开详情</span>
                  </div>
                  <div className="agent-config-io-scroll">
                    {Object.keys(exportAgentConfigs).length === 0 ? (
                      <div className="agent-config-empty">暂无可导出的渠道配置</div>
                    ) : (
                      Object.keys(exportAgentConfigs).map((agentId) => {
                        const configState = exportAgentConfigs[agentId];
                        const selection = exportSelections[agentId] || {};
                        const agent = configurableAgents.find((item) => item.id === agentId);
                        const selectedCount = Object.values(selection).filter(Boolean).length;
                        const allSelected = configState.providers.length > 0 && selectedCount === configState.providers.length;
                        const expanded = !!exportExpanded[agentId];
                        return (
                          <div key={agentId} className="agent-config-io-agent">
                            <div className="agent-config-io-agent-header agent-config-io-collapsible">
                              <button
                                type="button"
                                className="agent-config-io-collapse-btn"
                                aria-expanded={expanded}
                                onClick={() => setExportExpanded((prev) => ({ ...prev, [agentId]: !prev[agentId] }))}
                              >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <strong>{agent?.name || getAgentName(agentId)}</strong>
                                <span className="agent-config-io-agent-count">已选 {selectedCount} / {configState.providers.length}</span>
                              </button>
                              {configState.providers.length > 0 && (
                                <button
                                  type="button"
                                  className={`agent-config-io-select-all ${allSelected ? "clear" : ""}`}
                                  onClick={() => toggleExportAgent(agentId)}
                                >
                                  {allSelected ? "清空" : "全选"}
                                </button>
                              )}
                            </div>
                            {expanded && (
                              <div className="agent-config-io-agent-channels">
                                {configState.providers.length === 0 ? (
                                  <div className="agent-config-empty compact">无渠道</div>
                                ) : configState.providers.map((provider) => (
                                  <label key={provider.providerId} className={`agent-config-io-row ${selection[provider.providerId] ? "selected" : ""}`}>
                                    <input
                                      type="checkbox"
                                      checked={!!selection[provider.providerId]}
                                      onChange={() => {
                                        setExportSelections((prev) => ({
                                          ...prev,
                                          [agentId]: { ...prev[agentId], [provider.providerId]: !prev[agentId]?.[provider.providerId] },
                                        }));
                                      }}
                                    />
                                    <div className="agent-config-io-row-main">
                                      <strong>{provider.displayName || provider.providerId}</strong>
                                      <code>{provider.providerId}</code>
                                    </div>
                                    <span className="agent-config-io-row-url">{provider.baseUrl || "未配置 URL"}</span>
                                    <span className="agent-config-io-row-models">{provider.models.length} 个模型</span>
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                  <label className="agent-config-io-apikey">
                    <input
                      type="checkbox"
                      checked={exportIncludeApiKeys}
                      onChange={(event) => setExportIncludeApiKeys(event.target.checked)}
                    />
                    <span className="agent-config-io-apikey-text">
                      <strong>包含 API Key</strong>
                      <small>取消勾选会以空字符串导出密钥，更安全</small>
                    </span>
                    <span className={`agent-config-io-apikey-state ${exportIncludeApiKeys ? "included" : "excluded"}`}>
                      {exportIncludeApiKeys ? "将包含密钥" : "不包含密钥"}
                    </span>
                  </label>
                  {exportError && <div className="status-message error">{exportError}</div>}
                  <div className="agent-config-io-footer">
                    <button type="button" className="btn-action" onClick={() => setExportOpen(false)} disabled={exporting}>取消</button>
                    <button
                      type="button"
                      className="filter-add-btn"
                      onClick={() => void handleExportSubmit()}
                      disabled={exporting || !anyExportSelected}
                    >
                      {exporting ? <Loader2 size={13} className="agent-config-spin" /> : <Download size={13} />}
                      导出到文件
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="settings-modal-overlay agent-config-io-overlay" onMouseDown={() => setImportOpen(false)}>
          <div className="settings-modal agent-config-io-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>导入渠道配置</h3>
                <div className="agent-config-subtitle">检查导入内容并处理同名冲突</div>
              </div>
              <button type="button" className="settings-modal-close" onClick={() => setImportOpen(false)} disabled={importing} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="settings-modal-content agent-config-io-content">
              {importLoading ? (
                <div className="agent-config-empty">正在读取导入文件...</div>
              ) : !importData ? (
                <>
                  <div className="agent-config-io-empty-state">
                    <div className="agent-config-io-empty-icon">
                      <Upload size={22} />
                    </div>
                    <strong>选择配置文件开始导入</strong>
                    <p>支持 HPP 导出的 JSON 配置包，可包含多个 Agent 和渠道。</p>
                    <button
                      type="button"
                      className="filter-add-btn"
                      onClick={() => void handleOpenImport()}
                    >
                      <Upload size={14} />
                      选择 JSON 文件
                    </button>
                  </div>
                  {importError && <div className="status-message error agent-config-io-error">{importError}</div>}
                  <div className="agent-config-io-footer">
                    <button type="button" className="btn-action" onClick={() => setImportOpen(false)}>关闭</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="agent-config-io-scroll">
                    {Object.keys(importData.agents).map((agentId) => {
                      const entry = importData.agents[agentId];
                      const targetAgent = configurableAgents.find((item) => item.id === agentId);
                      const targetConfig = importTargetConfigs[agentId];
                      const targetProviderIds = targetConfig?.providers.map((provider) => provider.providerId) || [];
                      const agentDecisions = importDecisions[agentId] || {};
                      const expanded = !!importExpanded[agentId];
                      if (!targetAgent) {
                        return (
                          <div key={agentId} className="agent-config-io-agent">
                            <div className="agent-config-io-agent-header">
                              <strong>{agentId}</strong>
                              <span className="agent-config-io-missing">此 Agent 未安装，将跳过</span>
                            </div>
                          </div>
                        );
                      }
                      const notSelected = entry.providers.filter((provider) =>
                        (agentDecisions[provider.providerId]?.action || "keep") === "skip"
                      ).length;
                      return (
                        <div key={agentId} className="agent-config-io-agent">
                          <div className="agent-config-io-agent-header agent-config-io-collapsible">
                            <button
                              type="button"
                              className="agent-config-io-collapse-btn"
                              onClick={() => setImportExpanded((prev) => ({ ...prev, [agentId]: !prev[agentId] }))}
                            >
                              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <strong>{targetAgent.name}</strong>
                              <span className="agent-config-io-agent-count">
                                {entry.providers.length} 个渠道
                                {notSelected > 0 && ` · ${notSelected} 跳过`}
                              </span>
                            </button>
                          </div>
                          {expanded && (
                            <div className="agent-config-io-agent-channels">
                              {entry.providers.map((incoming) => {
                                const providerExists = targetProviderIds.includes(incoming.providerId);
                                const decision = agentDecisions[incoming.providerId];
                                const action = decision?.action || (providerExists ? "overwrite" : "create");
                                const newProviderId = createCopiedProviderId(incoming.providerId, targetProviderIds);
                                const targetProviderId = decision?.action === "create"
                                  ? (decision.newProviderId || newProviderId)
                                  : incoming.providerId;
                                const setDecision = (nextAction: "overwrite" | "skip" | "create") => {
                                  setImportDecisions((prev) => ({
                                    ...prev,
                                    [agentId]: {
                                      ...prev[agentId],
                                      [incoming.providerId]: {
                                        action: nextAction,
                                        ...(nextAction === "create" ? { newProviderId } : {}),
                                      },
                                    },
                                  }));
                                };
                                return (
                                  <div key={incoming.providerId} className="agent-config-io-row import">
                                    <div className="agent-config-io-row-main">
                                      <strong>{incoming.displayName || incoming.providerId}</strong>
                                      <code>{targetProviderId}</code>
                                    </div>
                                    <span className="agent-config-io-row-url">{incoming.baseUrl || "未配置 URL"}</span>
                                    <span className={`agent-config-io-badge ${providerExists ? "conflict" : "new"}`}>
                                      {providerExists ? "同名冲突" : "新增"}
                                    </span>
                                    <select
                                      className="agent-config-io-decide"
                                      value={action}
                                      onChange={(event) => setDecision(event.target.value as "overwrite" | "skip" | "create")}
                                    >
                                      {providerExists ? (
                                        <>
                                          <option value="overwrite">覆盖</option>
                                          <option value="skip">跳过</option>
                                          <option value="create">另存为新 ID</option>
                                        </>
                                      ) : (
                                        <>
                                          <option value="create">新建</option>
                                          <option value="skip">跳过</option>
                                        </>
                                      )}
                                    </select>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {importError && <div className="status-message error agent-config-io-error">{importError}</div>}
                  <div className="agent-config-io-footer">
                    <button type="button" className="btn-action" onClick={() => setImportOpen(false)} disabled={importing}>取消</button>
                    <button
                      type="button"
                      className="filter-add-btn"
                      onClick={() => void handleApplyImport()}
                      disabled={importing}
                    >
                      {importing ? <Loader2 size={13} className="agent-config-spin" /> : <Save size={13} />}
                      {importing ? "导入中..." : "开始导入"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
