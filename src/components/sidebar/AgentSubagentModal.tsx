import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  normalizeAgentSubagentConfig,
  type AgentSubagentCapabilities,
  type AgentSubagentConfig,
} from "@shared/agent-subagent";
import { groupModelsByProvider } from "@shared/models";
import { useAnchoredOverlay } from "@shared/anchored-overlay";
import "./Settings.css";

type AgentSubagentModelOption = {
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
  const values = [
    config.defaultModel,
    ...Object.values(config.profiles).map((profile) => profile.model),
  ].filter((value): value is string => !!value);
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

function AgentSubagentModelPicker({
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
  const canInheritModel = capabilities.modelSelection !== "custom";
  const canSelectModel = capabilities.modelSelection !== "inherit";
  const profiles = capabilities.profiles || [];
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
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const updateConfig = (next: AgentSubagentConfig) => {
    setConfig(normalizeAgentSubagentConfig(next));
    setDirty(true);
    setStatus(null);
  };

  const handleDefaultModelChange = (model: string) => {
    updateConfig({
      ...config,
      defaultModelMode: model ? "custom" : "inherit",
      defaultModel: model || undefined,
    });
  };

  const handleProfileModelChange = (profileName: string, model: string) => {
    updateConfig({
      ...config,
      profiles: {
        ...config.profiles,
        [profileName]: model
          ? { modelMode: "custom", model }
          : { modelMode: "inherit" },
      },
    });
  };

  const handleSave = async () => {
    const normalized = normalizeAgentSubagentConfig(config);
    if (normalized.defaultModelMode === "custom" && !normalized.defaultModel) {
      setStatus({ type: "error", text: "请选择默认 subagent 模型" });
      return;
    }
    for (const [name, profile] of Object.entries(normalized.profiles)) {
      if (profile.modelMode === "custom" && !profile.model) {
        setStatus({ type: "error", text: `请为 ${name} 选择模型` });
        return;
      }
    }

    setSaving(true);
    setStatus(null);
    try {
      const value = await window.electronAPI.loadData("settings");
      const settings = asRecord(value);
      const subagentConfigs = asRecord(settings.subagentConfigs);
      const saved = await window.electronAPI.saveData("settings", {
        ...settings,
        subagentConfigs: {
          ...subagentConfigs,
          [agentId]: normalized,
        },
      });
      if (!saved.success) throw new Error(saved.error || "保存 SubAgent 设置失败");

      const reloadResult = await window.electronAPI.agentReloadConfig(agentId);
      setConfig(normalized);
      setDirty(false);
      if (reloadResult.success) {
        setStatus({
          type: "success",
          text: reloadResult.reloadedSessionIds?.length
            ? `已保存并应用到 ${reloadResult.reloadedSessionIds.length} 个 ${agentName} 会话`
            : `已保存，将在 ${agentName} 下次初始化时应用`,
        });
      } else {
        setStatus({
          type: "success",
          text: `已保存；${reloadResult.error || "当前会话暂未重载，将在下次初始化时应用"}`,
        });
      }
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="settings-modal-overlay agent-subagent-modal-overlay"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!saving) onClose();
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
          <button type="button" className="settings-modal-close" onClick={onClose} disabled={saving} aria-label="关闭">
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

              <div className="settings-general-row settings-subagent-row">
                <span className="settings-general-row-main">
                  <strong>默认 subagent 模型</strong>
                  <span>未单独配置的 Agent 使用此模型</span>
                </span>
                {canSelectModel ? (
                  <AgentSubagentModelPicker
                    value={config.defaultModelMode === "custom" ? config.defaultModel || "" : ""}
                    options={availableModels}
                    disabled={!config.enabled}
                    emptyLabel={canInheritModel ? "跟随主 Agent 当前模型" : "请选择模型"}
                    onChange={handleDefaultModelChange}
                    ariaLabel="默认 subagent 模型"
                  />
                ) : (
                  <span className="agent-compaction-native-value">跟随主 Agent</span>
                )}
              </div>

              {profiles.length > 0 && (
                <div className="settings-subagent-profiles">
                  <div className="settings-subagent-section-title">Agent 模型覆盖</div>
                  {profiles.map((profile) => {
                    const profileConfig = config.profiles[profile.name];
                    const selectedModel = profileConfig?.modelMode === "custom" ? profileConfig.model || "" : "";
                    return (
                      <div key={profile.name} className="settings-general-row settings-subagent-row settings-subagent-profile-row">
                        <span className="settings-general-row-main">
                          <strong>{profile.label || profile.name}</strong>
                          <span>{profile.description || profile.name}</span>
                        </span>
                        {canSelectModel ? (
                          <AgentSubagentModelPicker
                            value={selectedModel}
                            options={availableModels}
                            disabled={!config.enabled}
                            emptyLabel="跟随默认设置"
                            onChange={(model) => handleProfileModelChange(profile.name, model)}
                            ariaLabel={`${profile.label || profile.name} 模型`}
                          />
                        ) : (
                          <span className="agent-compaction-native-value">跟随默认设置</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="settings-compaction-note">
                Agent markdown profile 中显式声明的 model 优先于这里的设置；未配置时才继承此处或主 Agent 当前模型。
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
