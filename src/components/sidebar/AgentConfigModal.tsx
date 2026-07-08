import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Copy, Eye, EyeOff, Pencil, Plus, RefreshCw, Save, Trash2, Undo2, X, Zap } from "lucide-react";
import type { AgentConfigState, AgentCustomModelConfig, AgentModel, AgentProviderConfig } from "@/types";
import { AVAILABLE_AGENTS, getAgentName } from "@/lib/agents";
import { useChatStore } from "@/stores/chat-store";
import "./Settings.css";

type AgentConfigModalProps = {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onModelsUpdated: (agentId: string, models?: AgentModel[]) => void;
};

const CONFIGURABLE_AGENTS = new Set(["codex", "pi", "droid", "opencode"]);
const CONFIGURABLE_AGENT_LIST = AVAILABLE_AGENTS.filter((agent) => CONFIGURABLE_AGENTS.has(agent.id));

const emptyModel = (): AgentCustomModelConfig => ({
  id: "",
  name: "",
  reasoning: false,
  imageInput: false,
});

const createProvider = (index: number): AgentProviderConfig => ({
  providerId: `custom-${index}`,
  displayName: `Custom ${index}`,
  baseUrl: "",
  apiKey: "",
  models: [emptyModel()],
});

function cloneProvider(provider: AgentProviderConfig): AgentProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}

function createCopiedProvider(provider: AgentProviderConfig, existingIds: Set<string>): AgentProviderConfig {
  const baseId = `${provider.providerId}-copy`;
  let providerId = baseId;
  let index = 2;
  while (existingIds.has(providerId)) {
    providerId = `${baseId}-${index}`;
    index += 1;
  }
  return {
    ...cloneProvider(provider),
    providerId,
    displayName: `${provider.displayName || provider.providerId} Copy`,
  };
}

function getConfigPathLabel(agentId: string) {
  switch (agentId) {
    case "pi":
      return "~/.pi/agent/models.json";
    case "droid":
      return "~/.factory/settings.json";
    case "opencode":
      return "~/.config/opencode/opencode.json";
    case "codex":
      return "~/.codex/config.toml";
    default:
      return "agent local config";
  }
}

function getAgentHint(agentId: string) {
  switch (agentId) {
    case "pi":
      return "读取并写入 ~/.pi/agent/models.json，模型图片能力会写入 input。";
    case "droid":
      return "读取并写入 ~/.factory/settings.json 的 customModels，图片能力会映射到 noImageSupport。";
    case "opencode":
      return "读取并写入 OpenCode provider 配置，HPP 不额外保存渠道副本。";
    case "codex":
      return "启用渠道会替换 ~/.codex/config.toml 当前 provider 的 base_url、默认 model 和 auth.json 的 sk-key。";
    default:
      return "";
  }
}

export function AgentConfigModal({ agentId: initialAgentId, onClose, onModelsUpdated }: AgentConfigModalProps) {
  const [agentId, setAgentId] = useState(initialAgentId);
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const currentModelProvider = useChatStore((state) => state.currentModel?.provider);
  const configurable = CONFIGURABLE_AGENTS.has(agentId);
  const usesActivation = agentId === "codex";
  const [config, setConfig] = useState<AgentConfigState>({ providers: [] });
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [draft, setDraft] = useState<AgentProviderConfig | null>(null);
  const [editorBaseline, setEditorBaseline] = useState<AgentProviderConfig | null>(null);
  const [editorOriginalProviderId, setEditorOriginalProviderId] = useState<string>("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activatingProviderId, setActivatingProviderId] = useState<string>("");
  const [deletingProviderId, setDeletingProviderId] = useState<string>("");
  const [reloading, setReloading] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const apiKeyCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    setAgentId(initialAgentId);
  }, [initialAgentId]);

  const selectedSavedProvider = useMemo(
    () => config.providers.find((provider) => provider.providerId === selectedProviderId) || null,
    [config.providers, selectedProviderId]
  );

  const getPreferredProviderId = useCallback((state: AgentConfigState) => {
    if (usesActivation) return state.activeProviderId || "";

    const currentProviderId = agentId === activeAgentId ? currentModelProvider : "";
    if (currentProviderId && state.providers.some((provider) => provider.providerId === currentProviderId)) {
      return currentProviderId;
    }
    return state.providers[0]?.providerId || "";
  }, [activeAgentId, agentId, currentModelProvider, usesActivation]);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    setActivatingProviderId("");
    setDeletingProviderId("");
    setApiKeyVisible(false);
    setApiKeyCopied(false);
    try {
      const result = await window.electronAPI.agentConfigList(agentId);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "读取配置失败" });
        return;
      }
      setConfig(result.config);
      setSelectedProviderId(getPreferredProviderId(result.config));
      setDraft(null);
      setEditorBaseline(null);
      setEditorOriginalProviderId("");
      setEditorOpen(false);
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [agentId, getPreferredProviderId]);

  useEffect(() => {
    if (!configurable) {
      setLoading(false);
      return;
    }
    void loadConfig();
  }, [configurable, loadConfig]);

  useEffect(() => {
    setApiKeyCopied(false);
  }, [selectedSavedProvider]);

  useEffect(() => {
    if (loading || !selectedProviderId) return;
    const item = providerItemRefs.current[selectedProviderId];
    if (!item) return;
    const frame = requestAnimationFrame(() => {
      item.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, selectedProviderId, config.providers]);

  useEffect(() => {
    return () => {
      if (apiKeyCopyTimer.current) clearTimeout(apiKeyCopyTimer.current);
    };
  }, []);

  const handleReload = useCallback(async () => {
    setReloading(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentReloadConfig(agentId);
      if (!result.success) {
        setStatus({ type: "error", text: result.error || "重载配置失败" });
        return;
      }
      onModelsUpdated(agentId, result.models);
      const count = result.reloadedSessionIds?.length || 0;
      setStatus({
        type: "success",
        text: count > 0 ? `已重载 ${count} 个会话` : "暂无已初始化会话，下次启动会话时会读取新配置",
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setReloading(false);
    }
  }, [agentId, onModelsUpdated]);

  const handleAddProvider = useCallback(() => {
    const existingIds = new Set(config.providers.map((provider) => provider.providerId));
    let index = config.providers.length + 1;
    while (existingIds.has(`custom-${index}`)) index += 1;
    const provider = createProvider(index);
    if (agentId === "codex") {
      provider.models = [{ ...provider.models[0], reasoning: true, imageInput: true }];
    }
    if (!usesActivation) setSelectedProviderId(provider.providerId);
    setDraft(provider);
    setEditorBaseline(cloneProvider(provider));
    setEditorOriginalProviderId("");
    setEditorOpen(true);
    setStatus(null);
  }, [agentId, config.providers, usesActivation]);

  const handleSelectProvider = useCallback((provider: AgentProviderConfig) => {
    setSelectedProviderId(provider.providerId);
    setStatus(null);
  }, []);

  const handleEditProvider = useCallback((provider: AgentProviderConfig) => {
    const nextDraft = cloneProvider(provider);
    setSelectedProviderId(provider.providerId);
    setDraft(nextDraft);
    setEditorBaseline(cloneProvider(nextDraft));
    setEditorOriginalProviderId(provider.providerId);
    setEditorOpen(true);
    setStatus(null);
  }, []);

  const handleCopyProvider = useCallback((provider: AgentProviderConfig) => {
    const existingIds = new Set(config.providers.map((item) => item.providerId));
    const copiedProvider = createCopiedProvider(provider, existingIds);
    if (!usesActivation) setSelectedProviderId(copiedProvider.providerId);
    setDraft(copiedProvider);
    setEditorBaseline(cloneProvider(copiedProvider));
    setEditorOriginalProviderId("");
    setEditorOpen(true);
    setStatus({ type: "success", text: "已复制为新渠道草稿，保存后写入配置" });
  }, [config.providers, usesActivation]);

  const handleUndoDraft = useCallback(() => {
    if (!editorBaseline) return;
    setDraft(cloneProvider(editorBaseline));
    setApiKeyCopied(false);
    setStatus({ type: "success", text: "已撤销未保存改动" });
  }, [editorBaseline]);

  const updateDraft = useCallback((patch: Partial<AgentProviderConfig>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }, []);

  const updateModel = useCallback((index: number, patch: Partial<AgentCustomModelConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        models: current.models.map((model, modelIndex) =>
          modelIndex === index ? { ...model, ...patch } : model
        ),
      };
    });
  }, []);

  const addModel = useCallback(() => {
    setDraft((current) => current ? { ...current, models: [...current.models, emptyModel()] } : current);
  }, []);

  const removeModel = useCallback((index: number) => {
    setDraft((current) => {
      if (!current || current.models.length <= 1) return current;
      return { ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    try {
      const normalizedDraft = {
        ...draft,
        providerId: draft.providerId.trim(),
        displayName: (draft.displayName || draft.providerId).trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        models: draft.models.map((model) => ({
          ...model,
          id: model.id.trim(),
          name: (model.name || model.id).trim(),
          reasoning: agentId === "codex" ? true : model.reasoning,
          imageInput: agentId === "codex" ? true : model.imageInput,
        })),
      };
      const payload = editorOriginalProviderId
        ? { ...normalizedDraft, originalProviderId: editorOriginalProviderId }
        : normalizedDraft;
      const result = await window.electronAPI.agentConfigSave(agentId, payload as AgentProviderConfig);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "保存配置失败" });
        return;
      }
      setConfig(result.config);
      const isNewProvider = !editorOriginalProviderId;
      const keepSelectedProviderId = selectedProviderId && result.config.providers.some((provider) =>
        provider.providerId === selectedProviderId
      );
      setSelectedProviderId(
        usesActivation && isNewProvider
          ? (keepSelectedProviderId ? selectedProviderId : result.config.activeProviderId || "")
          : normalizedDraft.providerId
      );
      setDraft(cloneProvider(normalizedDraft));
      setEditorBaseline(null);
      setEditorOriginalProviderId("");
      setEditorOpen(false);
      if (!usesActivation && result.models && result.models.length > 0) {
        onModelsUpdated(agentId, result.models);
      }
      const count = result.reloadedSessionIds?.length || 0;
      setStatus({
        type: "success",
        text: usesActivation
          ? normalizedDraft.providerId === result.config.activeProviderId
            ? "配置已保存，点击重新应用后写入本地配置并重载"
            : "配置已保存，点击启用后写入本地配置并重载"
          : result.error || (count > 0
            ? `本地配置已保存，已重载 ${count} 个会话`
            : "本地配置已保存，暂无已初始化会话"),
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [agentId, draft, editorOriginalProviderId, onModelsUpdated, selectedProviderId, usesActivation]);

  const handleActivate = useCallback(async (providerId: string) => {
    setActivatingProviderId(providerId);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentConfigActivate(agentId, providerId);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "启用渠道失败" });
        return;
      }
      setConfig(result.config);
      setSelectedProviderId(providerId);
      const provider = result.config.providers.find((item) => item.providerId === providerId);
      setDraft(provider ? cloneProvider(provider) : null);
      onModelsUpdated(agentId, result.models);
      const count = result.reloadedSessionIds?.length || 0;
      setStatus({
        type: "success",
        text: count > 0 ? "渠道已启用并完成重载" : "渠道已写入本地配置，下次启动会话时生效",
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setActivatingProviderId("");
    }
  }, [agentId, onModelsUpdated]);

  const handleDelete = useCallback(async (providerId: string) => {
    setDeletingProviderId(providerId);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentConfigDelete(agentId, providerId);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "删除渠道失败" });
        return;
      }
      setConfig(result.config);
      const nextSelected = usesActivation
        ? result.config.activeProviderId || result.config.providers[0]?.providerId || ""
        : result.config.providers[0]?.providerId || "";
      setSelectedProviderId(nextSelected);
      setDraft(null);
      setEditorBaseline(null);
      setEditorOriginalProviderId("");
      setEditorOpen(false);
      if (result.models && result.models.length > 0) {
        onModelsUpdated(agentId, result.models);
      }
      setStatus({
        type: "success",
        text: usesActivation
          ? "渠道草稿已删除，本地 Codex 当前配置未被清理"
          : result.error || "渠道已从本地配置删除",
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeletingProviderId("");
    }
  }, [agentId, onModelsUpdated, usesActivation]);

  const handleCopyApiKey = useCallback(async () => {
    const apiKey = draft?.apiKey || "";
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setApiKeyCopied(true);
      if (apiKeyCopyTimer.current) clearTimeout(apiKeyCopyTimer.current);
      apiKeyCopyTimer.current = setTimeout(() => setApiKeyCopied(false), 1200);
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : "复制 sk-key 失败" });
    }
  }, [draft?.apiKey]);

  return (
    <div className="settings-modal-overlay agent-config-modal-overlay" onMouseDown={onClose}>
      <div className="settings-modal agent-config-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-modal-header agent-config-header">
          <div className="agent-config-header-main">
            <div className="agent-config-title-row">
              <h3>{getAgentName(agentId)} 配置</h3>
            </div>
            <div className="agent-config-subtitle">{getConfigPathLabel(agentId)}</div>
            <div className="agent-config-tabs" role="tablist" aria-label="Agent 配置切换">
              {CONFIGURABLE_AGENT_LIST.map((agent) => {
                const active = agent.id === agentId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`agent-config-tab ${active ? "active" : ""}`}
                    onClick={() => setAgentId(agent.id)}
                  >
                    {agent.name}
                  </button>
                );
              })}
            </div>
          </div>
          <button type="button" className="settings-modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="settings-modal-content agent-config-content">
          <div className="agent-config-toolbar">
            <span>{getAgentHint(agentId)}</span>
            <button type="button" className="btn-action" onClick={handleReload} disabled={reloading}>
              <RefreshCw size={13} />
              {reloading ? "重载中..." : "重新载入当前配置"}
            </button>
          </div>

          {!configurable ? (
            <div className="agent-config-empty">
              当前 Agent 暂不支持自定义渠道配置。
            </div>
          ) : loading ? (
            <div className="agent-config-empty">读取配置中...</div>
          ) : (
            <div className="agent-config-grid">
              <aside className="agent-config-provider-list">
                <div className="agent-config-section-title">渠道</div>
                <div className="agent-config-provider-scroll">
                  {config.providers.length === 0 && (
                    <div className="agent-config-empty compact">暂无渠道</div>
                  )}
                  {config.providers.map((provider) => {
                    const active = usesActivation && provider.providerId === config.activeProviderId;
                    const selected = provider.providerId === selectedProviderId;
                    const activating = activatingProviderId === provider.providerId;
                    const title = provider.displayName || provider.providerId;
                    const initial = title.trim().slice(0, 1).toUpperCase() || "C";
                    return (
                      <div
                        key={provider.providerId}
                        ref={(element) => {
                          providerItemRefs.current[provider.providerId] = element;
                        }}
                        className={`agent-config-provider-item ${selected ? "selected" : ""} ${active ? "active" : ""}`}
                        onClick={() => handleSelectProvider(provider)}
                      >
                        <div className="agent-config-provider-avatar">{initial}</div>
                        <div className="agent-config-provider-main">
                          <div className="agent-config-provider-title-line">
                            <span className="agent-config-provider-name">{title}</span>
                            {active && <CheckCircle2 size={13} className="agent-config-provider-check" />}
                          </div>
                          <span className="agent-config-provider-url">{provider.baseUrl || "未配置 URL"}</span>
                          <span className="agent-config-provider-id">
                            {provider.providerId} · {provider.models.length} 个模型
                          </span>
                        </div>
                        {usesActivation && (
                          <div className="agent-config-provider-actions">
                            {active ? (
                              <span className="agent-config-active-badge">当前</span>
                            ) : (
                              <button
                                type="button"
                                className="btn-action agent-config-mini-btn"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleActivate(provider.providerId);
                                }}
                                disabled={!!activatingProviderId}
                              >
                                {activating ? "启用中..." : "启用"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="filter-add-btn agent-config-add-provider" onClick={handleAddProvider}>
                  <Plus size={13} />
                  新增渠道
                </button>
              </aside>

              <section className="agent-config-form">
                {!selectedSavedProvider ? (
                  <div className="agent-config-empty">选择左侧渠道，或新增一个渠道</div>
                ) : (
                  <>
                    <div className="agent-config-form-header">
                      <div className="agent-config-section-title">渠道配置</div>
                      <div className="agent-config-form-actions">
                        <button
                          type="button"
                          className="btn-action"
                          onClick={() => handleEditProvider(selectedSavedProvider)}
                        >
                          <Pencil size={13} />
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn-action"
                          onClick={() => handleCopyProvider(selectedSavedProvider)}
                        >
                          <Copy size={13} />
                          复制
                        </button>
                        <button
                          type="button"
                          className="btn-action"
                          onClick={() => void handleDelete(selectedSavedProvider.providerId)}
                          disabled={!!deletingProviderId || (usesActivation && selectedSavedProvider.providerId === config.activeProviderId)}
                          title={usesActivation && selectedSavedProvider.providerId === config.activeProviderId ? "请先启用其它渠道再删除当前渠道" : undefined}
                        >
                          <Trash2 size={13} />
                          {deletingProviderId ? "删除中..." : "删除"}
                        </button>
                      </div>
                    </div>

                    <div className="agent-config-summary">
                      <div className="agent-config-summary-row">
                        <span>渠道 ID</span>
                        <strong>{selectedSavedProvider.providerId}</strong>
                      </div>
                      <div className="agent-config-summary-row">
                        <span>显示名</span>
                        <strong>{selectedSavedProvider.displayName || selectedSavedProvider.providerId}</strong>
                      </div>
                      <div className="agent-config-summary-row wide">
                        <span>渠道 URL</span>
                        <strong>{selectedSavedProvider.baseUrl || "未配置"}</strong>
                      </div>
                      <div className="agent-config-summary-row">
                        <span>模型数量</span>
                        <strong>{selectedSavedProvider.models.length}</strong>
                      </div>
                    </div>

                    <div className="agent-config-summary-models">
                      <div className="agent-config-section-title">模型</div>
                      {selectedSavedProvider.models.length === 0 ? (
                        <div className="agent-config-empty compact">暂无模型</div>
                      ) : (
                        selectedSavedProvider.models.map((model) => (
                          <div key={model.id} className="agent-config-summary-model">
                            <span>{model.name || model.id}</span>
                            <code>{model.id}</code>
                          </div>
                        ))
                      )}
                    </div>
                    {usesActivation && (
                      <button
                        type="button"
                        className="filter-add-btn agent-config-activate-wide"
                        onClick={() => void handleActivate(selectedSavedProvider.providerId)}
                        disabled={!!activatingProviderId}
                      >
                        <Zap size={13} />
                        {activatingProviderId
                          ? "启用中..."
                          : selectedSavedProvider.providerId === config.activeProviderId
                            ? "重新应用当前渠道并重载"
                            : "启用此渠道并重载"}
                      </button>
                    )}
                  </>
                )}
              </section>
            </div>
          )}

          {status && (
            <div className={`status-message ${status.type}`}>
              {status.text}
            </div>
          )}
        </div>
      </div>
      {editorOpen && draft && (
        <div
          className="settings-modal-overlay agent-provider-editor-overlay"
          onMouseDown={(event) => {
            event.stopPropagation();
            setEditorOpen(false);
          }}
        >
          <div className="settings-modal agent-provider-editor-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>{editorOriginalProviderId ? "编辑渠道" : "新增渠道"}</h3>
                <div className="agent-config-subtitle">{draft.providerId || "new-provider"}</div>
              </div>
              <div className="agent-config-form-actions">
                <button
                  type="button"
                  className="btn-action"
                  onClick={handleUndoDraft}
                  disabled={!editorBaseline}
                >
                  <Undo2 size={13} />
                  撤销
                </button>
                <button type="button" className="filter-add-btn agent-config-save-btn" onClick={() => void handleSave()} disabled={saving}>
                  <Save size={13} />
                  {saving ? "保存中..." : "保存"}
                </button>
                <button
                  type="button"
                  className="settings-modal-close"
                  onClick={() => setEditorOpen(false)}
                  aria-label="关闭"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="settings-modal-content agent-provider-editor-content">
              <div className="agent-config-fields">
                <label>
                  <span>渠道 ID</span>
                  <input
                    value={draft.providerId}
                    onChange={(event) => updateDraft({ providerId: event.target.value })}
                    className="input-field"
                    placeholder="my-provider"
                  />
                </label>
                <label>
                  <span>显示名</span>
                  <input
                    value={draft.displayName}
                    onChange={(event) => updateDraft({ displayName: event.target.value })}
                    className="input-field"
                    placeholder="My Provider"
                  />
                </label>
                <label>
                  <span>渠道 URL</span>
                  <input
                    value={draft.baseUrl}
                    onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                    className="input-field"
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label>
                  <span>sk-key</span>
                  <div className="agent-config-secret-input">
                    <input
                      value={draft.apiKey}
                      onChange={(event) => {
                        updateDraft({ apiKey: event.target.value });
                        setApiKeyCopied(false);
                      }}
                      className="input-field"
                      placeholder="sk-..."
                      type={apiKeyVisible ? "text" : "password"}
                    />
                    <button
                      type="button"
                      className="btn-icon agent-config-secret-btn"
                      onClick={() => setApiKeyVisible((visible) => !visible)}
                      title={apiKeyVisible ? "隐藏 sk-key" : "显示 sk-key"}
                      aria-label={apiKeyVisible ? "隐藏 sk-key" : "显示 sk-key"}
                    >
                      {apiKeyVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      type="button"
                      className={`btn-icon agent-config-secret-btn ${apiKeyCopied ? "copied" : ""}`}
                      onClick={() => void handleCopyApiKey()}
                      disabled={!draft.apiKey}
                      title="复制 sk-key"
                      aria-label="复制 sk-key"
                    >
                      {apiKeyCopied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </label>
              </div>

              <div className="agent-config-models-header">
                <div className="agent-config-section-title">模型</div>
                <button type="button" className="btn-action agent-config-mini-btn" onClick={addModel}>
                  <Plus size={13} />
                  添加模型
                </button>
              </div>
              <div className="agent-config-model-list">
                {draft.models.map((model, index) => (
                  <div key={index} className="agent-config-model-row">
                    <input
                      value={model.id}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                      className="input-field"
                      placeholder="model-id"
                    />
                    <input
                      value={model.name}
                      onChange={(event) => updateModel(index, { name: event.target.value })}
                      className="input-field"
                      placeholder="显示名"
                    />
                    <label className="agent-config-check">
                      <input
                        type="checkbox"
                        checked={model.reasoning}
                        onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
                      />
                      Reasoning
                    </label>
                    <label className="agent-config-check">
                      <input
                        type="checkbox"
                        checked={model.imageInput}
                        onChange={(event) => updateModel(index, { imageInput: event.target.checked })}
                      />
                      图片
                    </label>
                    <button
                      type="button"
                      className="btn-icon btn-delete"
                      onClick={() => removeModel(index)}
                      disabled={draft.models.length <= 1}
                      title="删除模型"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
