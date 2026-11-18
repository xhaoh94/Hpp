import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Bot, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import {
  MAX_AGENT_SUBAGENT_POOL_ENTRIES,
  normalizeAgentSubagentConfig,
  type AgentSubagentCapabilities,
  type AgentSubagentConfig,
  type AgentSubagentPoolEntry,
} from "@shared/agent-subagent";
import { groupModelsByProvider } from "@shared/models";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import "./Settings.css";

export type AgentSubagentModelOption = {
  value: string;
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
};

type AgentSubagentModelPickerProps = {
  value: string;
  options: AgentSubagentModelOption[];
  disabled?: boolean;
  emptyLabel: string;
  ariaLabel: string;
  onChange: (value: string) => void;
};

type AgentSubagentModalProps = {
  agentId: string;
  agentName: string;
  capabilities: AgentSubagentCapabilities;
  modelOptions: AgentSubagentModelOption[];
  onClose: () => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function withStoredModels(
  options: AgentSubagentModelOption[],
  config: AgentSubagentConfig,
): AgentSubagentModelOption[] {
  const values = (config.pool || [])
    .map((entry) => entry.model)
    .filter((value): value is string => !!value);
  const map = new Map(options.map((option) => [option.value, option]));
  for (const value of values) {
    if (map.has(value)) continue;
    const separator = value.indexOf("/");
    const provider = separator > 0 ? value.slice(0, separator) : "已保存模型";
    const id = separator > 0 ? value.slice(separator + 1) : value;
    map.set(value, {
      value,
      id,
      name: value,
      provider,
      providerLabel: provider,
    });
  }
  return [...map.values()];
}

export function AgentSubagentModelPicker({
  value,
  options,
  disabled = false,
  emptyLabel,
  ariaLabel,
  onChange,
}: AgentSubagentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = options.find((model) => model.value === value);
  const modelsByProvider = useMemo(() => groupModelsByProvider(options), [options]);
  const providers = useMemo(() => [...modelsByProvider.keys()], [modelsByProvider]);
  const menuStyle = useAnchoredOverlay(open, anchorRef, menuRef, { gap: 4, padding: 12 });

  useEffect(() => {
    if (!open) return;
    setExpandedProvider(selectedModel?.provider || null);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, selectedModel?.provider]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const selectModel = (model: AgentSubagentModelOption | null) => {
    onChange(model?.value || "");
    setOpen(false);
  };

  return (
    <div ref={anchorRef} className="settings-subagent-model-picker">
      <button
        type="button"
        className="settings-subagent-model-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="settings-subagent-model-trigger-label">
          {selectedModel?.name || emptyLabel}
        </span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          style={menuStyle}
          className="settings-subagent-model-menu"
          role="listbox"
          aria-label={ariaLabel}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={`settings-subagent-model-inherit ${!value ? "active" : ""}`}
            onClick={() => selectModel(null)}
          >
            <span>{emptyLabel}</span>
            {!value && <span className="settings-subagent-model-current">当前</span>}
          </button>
          {providers.map((provider) => {
            const providerModels = modelsByProvider.get(provider) || [];
            const isExpanded = expandedProvider === provider;
            const hasActiveModel = providerModels.some((model) => model.value === value);
            return (
              <div key={provider} className={`settings-subagent-model-provider-group ${isExpanded ? "expanded" : ""}`}>
                <button
                  type="button"
                  className={`settings-subagent-model-provider ${isExpanded ? "expanded" : ""} ${hasActiveModel ? "has-active" : ""}`}
                  onClick={() => setExpandedProvider(isExpanded ? null : provider)}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="settings-subagent-model-provider-name">
                    {providerModels[0]?.providerLabel || provider}
                  </span>
                  <span className="settings-subagent-model-provider-count">{providerModels.length}</span>
                </button>
                {isExpanded && providerModels.map((model) => {
                  const isActive = model.value === value;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      key={model.value}
                      className={`settings-subagent-model-item ${isActive ? "active" : ""}`}
                      onClick={() => selectModel(model)}
                    >
                      <span className="settings-subagent-model-item-name">{model.name}</span>
                      {isActive && <span className="settings-subagent-model-current">当前</span>}
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

export function AgentSubagentModal({
  agentId,
  agentName,
  capabilities,
  modelOptions,
  onClose,
}: AgentSubagentModalProps) {
  const [config, setConfig] = useState<AgentSubagentConfig>(() => normalizeAgentSubagentConfig(undefined));
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [addingPoolModel, setAddingPoolModel] = useState(false);
  const supportsModelPool = capabilities.modelPool === true;
  const pool = config.pool || [];
  const availableModels = useMemo(
    () => withStoredModels(modelOptions, config),
    [config, modelOptions],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDirty(false);
    setStatus(null);
    window.electronAPI.loadData("settings").then((value) => {
      if (cancelled) return;
      const settings = asRecord(value);
      const storedConfigs = asRecord(settings.subagentConfigs);
      setConfig(normalizeAgentSubagentConfig(storedConfigs[agentId]));
    }).catch((error) => {
      if (!cancelled) {
        setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void requestCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const updateConfig = (next: AgentSubagentConfig) => {
    setConfig(normalizeAgentSubagentConfig(next));
    setDirty(true);
    setStatus(null);
  };

  const handlePoolChange = (nextPool: AgentSubagentPoolEntry[]) => {
    updateConfig({ ...config, pool: nextPool });
  };

  const handlePoolAdd = (model: string) => {
    if (!model || pool.some((entry) => entry.model === model)) return;
    const option = availableModels.find((item) => item.value === model);
    handlePoolChange([
      ...pool,
      { model, ...(option?.name ? { label: option.name } : {}) },
    ]);
  };

  const handlePoolUpdate = (model: string, patch: Partial<AgentSubagentPoolEntry>) => {
    handlePoolChange(pool.map((entry) => (entry.model === model ? { ...entry, ...patch } : entry)));
  };

  const handlePoolRemove = (model: string) => {
    handlePoolChange(pool.filter((entry) => entry.model !== model));
  };

  /** 首项即默认起点，所以「置顶」比上下移动更贴近意图。 */
  const handlePoolPromote = (model: string) => {
    const target = pool.find((entry) => entry.model === model);
    if (!target || pool[0]?.model === model) return;
    handlePoolChange([target, ...pool.filter((entry) => entry.model !== model)]);
  };

  const handleSave = async (): Promise<boolean> => {
    const normalized = normalizeAgentSubagentConfig(config);

    setSaving(true);
    setStatus(null);
    try {
      // 由主进程按字段原子更新 settings，避免 renderer 读改写整个文件时覆盖
      // 其他窗口或其他设置项的并发修改。
      const saved = await window.electronAPI.agentConfigSaveSubagent(agentId, normalized);
      if (!saved.success) throw new Error(saved.error || "保存 SubAgent 设置失败");

      // 模型、profile 模型和热禁用可以直接热更新到运行中的会话：下一次
      // subagent 调用即使用新配置，无需重载会话。
      //
      // 模型池是例外：它会写进 subagent 工具的说明里，而工具说明是注册时
      // 的快照 —— 热更新只会改校验用的配置，模型看不到新加的候选，等于白配。
      // 开关也算在内：关掉后说明里还挂着候选，派发方会照旧传 model。
      const enablingFromDisabled = !config.enabled && normalized.enabled;
      const poolConfigChanged = JSON.stringify({ on: config.poolEnabled, pool: config.pool || [] })
        !== JSON.stringify({ on: normalized.poolEnabled, pool: normalized.pool });
      const applyConfig = window.electronAPI.agentSetAgentSubagentConfig;
      if (!enablingFromDisabled && !poolConfigChanged && typeof applyConfig === "function") {
        const applied = await applyConfig(agentId, normalized);
        if (!applied.success) throw new Error(applied.error || "SubAgent 设置热更新失败");
        if (applied.appliedSessionIds?.length) {
          setConfig(normalized);
          setDirty(false);
          setStatus({
            type: "success",
            text: `已保存并应用到 ${applied.appliedSessionIds.length} 个 ${agentName} 会话`,
          });
          return true;
        }
        // 没有赶上热更新的运行中会话（如插件未实现热更新）：回落到
        // 会话重载，空闲会话会重建一次以应用新配置。
      }

      const reloadResult = await window.electronAPI.agentReloadConfig(agentId);
      setConfig(normalized);
      setDirty(false);
      if (reloadResult.success) {
        setStatus({
          type: "success",
          text: reloadResult.reloadedSessionIds?.length
            ? `已保存并应用到 ${reloadResult.reloadedSessionIds.length} 个 ${agentName} 会话`
            : poolConfigChanged
              // 池子变了模型才能看见新候选，必须重建；没有空闲会话时只能等下次初始化。
              ? `已保存；模型池变更随 ${agentName} 会话下次初始化生效`
              : `已保存，将在 ${agentName} 下次初始化时应用`,
        });
      } else {
        setStatus({
          type: "success",
          text: `已保存；${reloadResult.error || "当前会话暂未重载，将在下次初始化时应用"}`,
        });
      }
      return true;
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  // 关闭时还没保存的选择要自动保存：SubAgent 设置只有保存才会下发到
  // 运行中的会话，直接丢弃会让用户以为配置“不生效”。
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef<() => Promise<boolean>>(handleSave);
  saveRef.current = handleSave;
  const requestClose = async () => {
    if (savingRef.current) return;
    if (dirtyRef.current && !(await saveRef.current())) return;
    onClose();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  return createPortal(
    <div
      className="settings-modal-overlay agent-subagent-modal-overlay"
      onMouseDown={(event) => {
        event.stopPropagation();
        void requestCloseRef.current();
      }}
    >
      <div
        className="settings-modal agent-subagent-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${agentName} 内置 Agent 设置`}
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="agent-subagent-modal-title">
            <span className="settings-general-heading-icon"><Bot size={16} /></span>
            <div>
              <h3>{agentName} SubAgent</h3>
              <p>配置 Hpp fallback subagent；用户或项目同名 Pi 扩展仍然优先</p>
            </div>
          </div>
          <button type="button" className="settings-modal-close" onClick={() => void requestCloseRef.current()} disabled={saving} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="settings-modal-content agent-subagent-modal-content">
          {loading ? (
            <div className="agent-config-empty">读取 SubAgent 设置中...</div>
          ) : (
            <div className="settings-subagent-body">
              <label className="settings-general-row settings-general-toggle settings-subagent-enabled">
                <span className="settings-general-row-main">
                  <strong>启用 SubAgent</strong>
                  <span>关闭后不注册 Hpp 内置 subagent 工具，不影响用户安装的同名扩展</span>
                </span>
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(event) => updateConfig({ ...config, enabled: event.target.checked })}
                  aria-label="启用 SubAgent"
                />
              </label>

              {supportsModelPool && (
                <label className="settings-general-row settings-general-toggle settings-subagent-row settings-subagent-pool-switch">
                  <span className="settings-general-row-main">
                    <strong>启用模型池</strong>
                    <span>
                      {config.poolEnabled
                        ? "派发任务时主 Agent 按每个任务的难度在池内挑模型；未指定时用第一项"
                        : "已关闭：所有 subagent 跟随主 Agent 当前模型，池内配置保留"}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={config.poolEnabled}
                    disabled={!config.enabled}
                    onChange={(event) => updateConfig({ ...config, poolEnabled: event.target.checked })}
                    aria-label="启用模型池"
                  />
                </label>
              )}

              {supportsModelPool && (
                <div className="settings-subagent-pool">
                  <div className="settings-subagent-section-header">
                    <span className="settings-subagent-section-title">模型池</span>
                    <span className="settings-subagent-pool-hint">
                      第一项是默认起点；上下文窗口、推理/视觉能力、价格会自动带上，不用手填
                    </span>
                  </div>

                  {pool.map((entry, index) => (
                    <div className="settings-subagent-pool-row" key={entry.model}>
                      <span className="settings-subagent-pool-index" title={index === 0 ? "默认起点" : undefined}>
                        {index + 1}
                      </span>
                      <AgentSubagentModelPicker
                        value={entry.model}
                        options={availableModels}
                        disabled={!config.enabled}
                        emptyLabel="选择模型"
                        onChange={(model) => {
                          if (!model) handlePoolRemove(entry.model);
                          else if (!pool.some((item) => item.model === model)) {
                            handlePoolUpdate(entry.model, {
                              model,
                              label: availableModels.find((item) => item.value === model)?.name,
                            });
                          }
                        }}
                        ariaLabel={`模型池第 ${index + 1} 项`}
                      />
                      {index > 0 ? (
                        <button
                          type="button"
                          className="settings-subagent-pool-action"
                          onClick={() => handlePoolPromote(entry.model)}
                          disabled={!config.enabled}
                          title="设为默认起点"
                          aria-label={`把 ${entry.model} 设为默认起点`}
                        >
                          <ArrowUp size={13} />
                        </button>
                      ) : (
                        <span className="settings-subagent-pool-action placeholder" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        className="settings-subagent-pool-action"
                        onClick={() => handlePoolRemove(entry.model)}
                        disabled={!config.enabled}
                        title="从模型池移除"
                        aria-label={`从模型池移除 ${entry.model}`}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}

                  {addingPoolModel && (
                    <div className="settings-subagent-pool-row pending">
                      <span className="settings-subagent-pool-index">+</span>
                      <AgentSubagentModelPicker
                        value=""
                        options={availableModels}
                        disabled={!config.enabled}
                        emptyLabel="选择要加入的模型"
                        onChange={(model) => {
                          setAddingPoolModel(false);
                          handlePoolAdd(model);
                        }}
                        ariaLabel="添加模型到模型池"
                      />
                      <span className="settings-subagent-pool-pending">选择后自动加入；再次点击可取消</span>
                    </div>
                  )}

                  {pool.length < MAX_AGENT_SUBAGENT_POOL_ENTRIES && !addingPoolModel && (
                    <button
                      type="button"
                      className="settings-subagent-pool-add"
                      onClick={() => setAddingPoolModel(true)}
                      disabled={!config.enabled}
                    >
                      <Plus size={13} />
                      添加模型
                    </button>
                  )}
                </div>
              )}

              {supportsModelPool && pool.length < 2 && (
                <p className="settings-compaction-note">
                  {pool.length === 0
                    ? "池是空的：subagent 会跟随主 Agent 当前模型，和关掉开关没区别。"
                    : "池里只有一个模型时没有可挑的空间：派发方只有一个选择，「按难度挑」不会发生。至少放两个模型才有意义。"}
                </p>
              )}

              <p className="settings-compaction-note">
                模型在派发时确定、整个子任务不变。派发方会看到每个模型的上下文窗口、推理/视觉能力和价格，
                由它自己按任务轻重挑；不指定则用池内第一项，关掉模型池则全部跟随主 Agent。
                markdown 里钉死的 model 固定不可改。
              </p>
              <div className="settings-compaction-actions">
                {status && (
                  <span className={`settings-compaction-status ${status.type}`}>{status.text}</span>
                )}
                <button
                  type="button"
                  className="filter-add-btn"
                  onClick={() => void handleSave()}
                  disabled={saving || !dirty}
                >
                  {saving ? "应用中..." : dirty ? "应用设置" : "已应用"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
