import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal, X } from "lucide-react";
import type { AgentCodemodeConfig } from "@/types/ipc";
import "./Settings.css";

type AgentCodemodeModalProps = {
  /** codemode 总开关当前值；关着时弹窗里的设置不会生效，需要给出提示。 */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onClose: () => void;
};

const DEFAULT_INLINE_BUDGET = 3000;

const MODE_OPTIONS: Array<{ value: "on" | "only"; label: string; detail: string }> = [
  {
    value: "on",
    label: "全部工具",
    detail: "脚本里能调 read、write、bash 等全部工具。",
  },
  {
    value: "only",
    label: "仅非直连工具",
    detail: "脚本只调codemode / deferred 档工具（如 MCP 的延迟工具），read、write、bash 这类直连工具不暴露给脚本。",
  },
];

export function AgentCodemodeModal({
  enabled,
  onEnabledChange,
  onClose,
}: AgentCodemodeModalProps) {
  const [config, setConfig] = useState<AgentCodemodeConfig>({
    mode: "on",
    inlineBudget: DEFAULT_INLINE_BUDGET,
  });
  const [initial, setInitial] = useState<AgentCodemodeConfig | null>(null);
  const [stored, setStored] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.agentCodemodeGetConfig().then((result) => {
      if (cancelled) return;
      if (result.success && result.config) {
        setConfig(result.config);
        setInitial(result.config);
        setStored(result.stored === true);
      } else if (!result.success) {
        setStatus({ type: "error", text: result.error || "读取 codemode 配置失败" });
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const dirty = initial !== null
    && (config.mode !== initial.mode || config.inlineBudget !== initial.inlineBudget);

  const handleToggle = async (next: boolean) => {
    setToggling(true);
    setStatus(null);
    try {
      await onEnabledChange(next);
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    if (!Number.isFinite(config.inlineBudget) || config.inlineBudget < 0) {
      setStatus({ type: "error", text: "工具说明预算必须是不小于 0 的数字" });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentCodemodeSetConfig(config);
      if (!result.success) {
        setStatus({ type: "error", text: result.error || "保存失败" });
        return;
      }
      if (result.config) {
        setConfig(result.config);
        setInitial(result.config);
      }
      setStatus({
        type: result.error ? "error" : "success",
        // 没开会话时主进程的 appliedSessionIds 是空的，别谎报「已重载」。
        text: result.error
          || (result.reconnected ? "已保存，运行中的会话已重载" : "已保存。新会话启动时生效。"),
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const handleClose = useCallback(() => {
    if (saving) return;
    if (dirty && !window.confirm("有未保存的改动，确定关闭？")) return;
    onClose();
  }, [dirty, onClose, saving]);

  return createPortal(
    <div
      className="settings-modal-overlay agent-codemode-modal-overlay"
      onMouseDown={(event) => {
        event.stopPropagation();
        handleClose();
      }}
    >
      <div
        className="settings-modal agent-codemode-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Codemode 设置"
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="agent-codemode-modal-title">
            <span className="settings-general-heading-icon"><Terminal size={16} /></span>
            <div>
              <h3>Codemode</h3>
              <p>模型用一段JavaScript 编排工具调用，在 QuickJS 沙箱里执行</p>
            </div>
          </div>
          <button type="button" className="settings-modal-close" onClick={handleClose} disabled={saving} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="settings-modal-content agent-codemode-modal-content">
          <section className="agent-mcp-section">
            <label className="agent-mcp-enabled-row">
              <input
                type="checkbox"
                checked={enabled}
                disabled={loading || toggling}
                onChange={(event) => void handleToggle(event.target.checked)}
              />
              <span>
                启用 Codemode
                <small>
                  {enabled
                    ? "模型可以用脚本批量编排工具调用"
                    : "关闭后模型看不到 codemode 工具；下面的设置仍会保存，但不会生效"}
                </small>
              </span>
            </label>
          </section>

          {!enabled && (
            <div className="agent-codemode-inactive-hint">
              Codemode 当前是关闭的。下面的设置会写入 pi 配置，但要有 Codemode 工具可用才会生效。
            </div>
          )}

          <section className="agent-mcp-section">
            <div className="agent-mcp-scope-row">
              <span className="agent-codemode-field-label">脚本可见范围</span>
            </div>
            <div className="agent-codemode-mode-options" role="radiogroup" aria-label="脚本可见范围">
              {MODE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="agent-codemode-mode-option"
                >
                  <input
                    type="radio"
                    name="codemode-mode"
                    checked={config.mode === option.value}
                    disabled={loading || saving}
                    onChange={() => setConfig((current) => ({ ...current, mode: option.value }))}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="agent-mcp-section">
            <label className="agent-codemode-budget-row">
              <span className="agent-codemode-field-label">工具说明预算</span>
              <span className="agent-codemode-budget-input">
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={config.inlineBudget}
                  disabled={loading || saving}
                  onChange={(event) => setConfig((current) => ({
                    ...current,
                    inlineBudget: event.target.value === "" ? 0 : Number(event.target.value),
                  }))}
                />
                <span className="agent-codemode-budget-unit">token</span>
              </span>
            </label>
            <p className="agent-mcp-hint">
              写进 codemode 工具描述里的工具清单预算上限。工具很多（MCP 接了多个 server）时
              描述会膨胀、调高这个值；默认 {DEFAULT_INLINE_BUDGET}，超出部分会被截断。
            </p>
          </section>

          {status && <div className={`agent-mcp-status ${status.type}`}>{status.text}</div>}
        </div>

        <div className="agent-mcp-footer">
          <div className="agent-mcp-add-actions">
            {!stored && !dirty && (
              <span className="agent-codemode-default-note">尚未自定义，使用 pi 默认值</span>
            )}
          </div>
          <div className="agent-mcp-footer-main">
            <button type="button" className="btn-action" onClick={handleClose} disabled={saving}>
              关闭
            </button>
            <button
              type="button"
              className="btn-primary agent-mcp-save"
              onClick={() => void handleSave()}
              disabled={saving || loading || !dirty}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
