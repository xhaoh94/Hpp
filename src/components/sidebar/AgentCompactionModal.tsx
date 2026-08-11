import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BrainCircuit, X } from "lucide-react";
import type { AgentCompactionCapabilities } from "@/types";
import {
  isCustomAgentCompactionModelConfigured,
  normalizeAgentCompactionConfig,
  resolveStoredAgentCompactionConfig,
  setStoredAgentCompactionConfig,
  type AgentCompactionConfig,
} from "@shared/agent-compaction";
import "./Settings.css";

type AgentCompactionModalProps = {
  agentId: string;
  agentName: string;
  capabilities: AgentCompactionCapabilities;
  onClose: () => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeForCapabilities(
  value: unknown,
  capabilities: AgentCompactionCapabilities,
): AgentCompactionConfig {
  const normalized = normalizeAgentCompactionConfig(value);
  return {
    ...normalized,
    thinkingLevel: capabilities.thinkingLevel ? normalized.thinkingLevel : "inherit",
    modelMode: capabilities.customModel ? normalized.modelMode : "current",
    customModel: {
      ...normalized.customModel,
      reasoning: capabilities.thinkingLevel && normalized.customModel.reasoning,
    },
  };
}

export function AgentCompactionModal({
  agentId,
  agentName,
  capabilities,
  onClose,
}: AgentCompactionModalProps) {
  const [config, setConfig] = useState<AgentCompactionConfig>(() => normalizeForCapabilities(undefined, capabilities));
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDirty(false);
    setStatus(null);
    window.electronAPI.loadData("settings").then((value) => {
      if (cancelled) return;
      const settings = asRecord(value);
      const general = asRecord(settings.general);
      const stored = resolveStoredAgentCompactionConfig(
        agentId,
        general.agentCompactionByAgent,
        general.agentCompaction,
      );
      setConfig(normalizeForCapabilities(stored, capabilities));
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
  }, [agentId, capabilities]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const updateConfig = (next: AgentCompactionConfig) => {
    setConfig(normalizeForCapabilities(next, capabilities));
    setDirty(true);
    setStatus(null);
  };

  const handleSave = async () => {
    const normalized = normalizeForCapabilities(config, capabilities);
    if (normalized.modelMode === "custom" && !isCustomAgentCompactionModelConfigured(normalized)) {
      setStatus({ type: "error", text: "自定义压缩模型需要填写 Base URL 和模型 ID" });
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const value = await window.electronAPI.loadData("settings");
      const settings = asRecord(value);
      const general = asRecord(settings.general);
      const saved = await window.electronAPI.saveData("settings", {
        ...settings,
        general: {
          ...general,
          agentCompactionByAgent: setStoredAgentCompactionConfig(
            general.agentCompactionByAgent,
            agentId,
            normalized,
          ),
        },
      });
      if (!saved.success) throw new Error(saved.error || "保存压缩设置失败");

      const applyConfig = window.electronAPI.agentSetAgentCompactionConfig;
      if (typeof applyConfig !== "function") {
        setConfig(normalized);
        setDirty(false);
        setStatus({
          type: "success",
          text: "已保存；完全退出并重启 Hpp 后将应用到该 Agent",
        });
        return;
      }

      const applied = await applyConfig(agentId, normalized);
      if (!applied.success) throw new Error(applied.error || "压缩设置热更新失败");
      setConfig(normalized);
      setDirty(false);
      setStatus({
        type: "success",
        text: applied.appliedSessionIds?.length
          ? `已保存并应用到 ${applied.appliedSessionIds.length} 个 ${agentName} 会话`
          : `已保存，将在 ${agentName} 下次初始化时应用`,
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="settings-modal-overlay agent-compaction-modal-overlay"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!saving) onClose();
      }}
    >
      <div
        className="settings-modal agent-compaction-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${agentName} 上下文压缩设置`}
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="agent-compaction-modal-title">
            <span className="settings-general-heading-icon"><BrainCircuit size={16} /></span>
            <div>
              <h3>{agentName} 上下文压缩</h3>
              <p>此设置只应用于 {agentName} 会话</p>
            </div>
          </div>
          <button type="button" className="settings-modal-close" onClick={onClose} disabled={saving} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="settings-modal-content agent-compaction-modal-content">
          {loading ? (
            <div className="agent-config-empty">读取压缩设置中...</div>
          ) : (
            <div className="settings-compaction-body">
              {capabilities.thinkingLevel ? (
                <div className="settings-general-row settings-compaction-row">
                  <span className="settings-general-row-main">
                    <strong>压缩思考等级</strong>
                    <span>仅影响上下文摘要，不改变聊天栏选择的思考等级</span>
                  </span>
                  <select
                    className="settings-compaction-select"
                    value={config.thinkingLevel}
                    onChange={(event) => updateConfig({
                      ...config,
                      thinkingLevel: event.target.value as AgentCompactionConfig["thinkingLevel"],
                    })}
                    aria-label="压缩思考等级"
                  >
                    <option value="inherit">跟随聊天</option>
                    <option value="off">关闭</option>
                    <option value="minimal">最低</option>
                    <option value="low">低（默认）</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="xhigh">超高</option>
                    <option value="max">最大</option>
                  </select>
                </div>
              ) : (
                <div className="settings-general-row settings-compaction-row">
                  <span className="settings-general-row-main">
                    <strong>压缩思考等级</strong>
                    <span>该 Agent 插件未声明独立压缩思考等级能力</span>
                  </span>
                  <span className="agent-compaction-native-value">由 Agent 原生处理</span>
                </div>
              )}

              {capabilities.customModel && (
                <>
                  <div className="settings-general-row settings-compaction-row">
                    <span className="settings-general-row-main">
                      <strong>压缩模型</strong>
                      <span>可沿用当前 Agent 模型，或调用独立的 OpenAI 兼容模型</span>
                    </span>
                    <select
                      className="settings-compaction-select"
                      value={config.modelMode}
                      onChange={(event) => updateConfig({
                        ...config,
                        modelMode: event.target.value === "custom" ? "custom" : "current",
                      })}
                      aria-label="压缩模型来源"
                    >
                      <option value="current">当前 Agent 模型</option>
                      <option value="custom">自定义模型</option>
                    </select>
                  </div>

                  {config.modelMode === "custom" && (
                    <div className="settings-compaction-custom-model">
                      <label className="settings-compaction-field">
                        <span>Base URL</span>
                        <input
                          className="settings-compaction-input"
                          value={config.customModel.baseUrl}
                          onChange={(event) => updateConfig({
                            ...config,
                            customModel: { ...config.customModel, baseUrl: event.target.value },
                          })}
                          placeholder="https://api.example.com/v1"
                          spellCheck={false}
                        />
                      </label>
                      <label className="settings-compaction-field">
                        <span>模型 ID</span>
                        <input
                          className="settings-compaction-input"
                          value={config.customModel.modelId}
                          onChange={(event) => updateConfig({
                            ...config,
                            customModel: { ...config.customModel, modelId: event.target.value },
                          })}
                          placeholder="例如 gpt-4.1-mini"
                          spellCheck={false}
                        />
                      </label>
                      <label className="settings-compaction-field">
                        <span>API 协议</span>
                        <select
                          className="settings-compaction-select settings-compaction-field-control"
                          value={config.customModel.api}
                          onChange={(event) => updateConfig({
                            ...config,
                            customModel: {
                              ...config.customModel,
                              api: event.target.value === "openai-responses" ? "openai-responses" : "openai-completions",
                            },
                          })}
                        >
                          <option value="openai-completions">Chat Completions</option>
                          <option value="openai-responses">Responses</option>
                        </select>
                      </label>
                      <label className="settings-compaction-field">
                        <span>API Key</span>
                        <input
                          type="password"
                          className="settings-compaction-input"
                          value={config.customModel.apiKey}
                          onChange={(event) => updateConfig({
                            ...config,
                            customModel: { ...config.customModel, apiKey: event.target.value },
                          })}
                          placeholder="本地无鉴权服务可留空"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      {capabilities.thinkingLevel && (
                        <label className="settings-general-row settings-general-toggle settings-compaction-reasoning">
                          <span className="settings-general-row-main">
                            <strong>模型支持思考</strong>
                            <span>开启后才会向自定义模型发送所选压缩思考等级</span>
                          </span>
                          <input
                            type="checkbox"
                            checked={config.customModel.reasoning}
                            onChange={(event) => updateConfig({
                              ...config,
                              customModel: { ...config.customModel, reasoning: event.target.checked },
                            })}
                            aria-label="自定义压缩模型支持思考"
                          />
                        </label>
                      )}
                    </div>
                  )}
                </>
              )}

              <p className="settings-compaction-note">
                可用字段由当前 Agent 插件的 capabilities.compaction 声明决定。
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
                  {saving ? "应用中..." : dirty ? "应用压缩设置" : "已应用"}
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
