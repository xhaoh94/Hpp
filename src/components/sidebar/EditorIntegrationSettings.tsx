import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Copy, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";

import type { EditorBridgeStatus, EditorBridgeTargetInfo } from "@shared/editor-bridge-protocol";
import { showFloatingToastMessage } from "@/lib/floating-toast";

const needsUpdate = (target: EditorBridgeTargetInfo) =>
  !!target.installedVersion && !!target.bundledVersion && target.installedVersion !== target.bundledVersion;

const targetStatusText = (target: EditorBridgeTargetInfo) => {
  if (target.kind === "config") return target.configured ? "任务已写入" : "未接入";
  if (!target.cliPath) return "已安装，但找不到命令行工具";
  if (needsUpdate(target)) return `插件 ${target.installedVersion}，可更新到 ${target.bundledVersion}`;
  if (target.installedVersion) return `插件已安装 ${target.installedVersion}`;
  return "已安装，插件未装";
};

const targetActionLabel = (target: EditorBridgeTargetInfo) => {
  if (target.kind === "config") return target.configured ? "重新写入" : "写入配置";
  if (needsUpdate(target)) return `更新到 ${target.bundledVersion}`;
  return target.configured ? "重新安装" : "安装插件";
};

export function EditorIntegrationSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<EditorBridgeStatus | null>(null);
  const [targets, setTargets] = useState<EditorBridgeTargetInfo[]>([]);
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [keymapSnippet, setKeymapSnippet] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextTargets] = await Promise.all([
        window.electronAPI.editorBridgeGetStatus(),
        window.electronAPI.editorBridgeListTargets(),
      ]);
      setStatus(nextStatus);
      setTargets(nextTargets);
      setError(nextStatus.error || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async (target: EditorBridgeTargetInfo) => {
    setBusyId(target.id);
    setError("");
    setKeymapSnippet("");
    try {
      if (target.kind === "config") {
        const result = await window.electronAPI.editorBridgeInstallZed();
        if (!result.success) {
          setError(result.error || "写入失败。");
          return;
        }
        showFloatingToastMessage("已写入 Zed 配置");
        if (result.keymapSnippet) setKeymapSnippet(result.keymapSnippet);
      } else {
        const result = await window.electronAPI.editorBridgeInstallExtension(target.id);
        if (!result.success) {
          setError(result.error || "安装失败。");
          return;
        }
        showFloatingToastMessage(`已安装到 ${target.label}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }, [refresh]);

  const copyKeymapSnippet = useCallback(async () => {
    if (!keymapSnippet) return;
    await navigator.clipboard.writeText(keymapSnippet);
    showFloatingToastMessage("已复制键位片段");
  }, [keymapSnippet]);

  const installedTargets = targets.filter((target) => target.appInstalled);
  const availableTargets = targets.filter((target) => !target.appInstalled);

  return (
    <div className="settings-modal-overlay editor-bridge-overlay" onClick={onClose}>
      <div
        className="settings-modal editor-bridge-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-bridge-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="editor-bridge-title">
            <PlugZap size={18} />
            <div>
              <h3 id="editor-bridge-title">编辑器集成</h3>
              <span>在编辑器里把手上的代码直接送进聊天输入框</span>
            </div>
          </div>
          <button autoFocus onClick={onClose} className="settings-modal-close" aria-label="关闭">×</button>
        </div>

        <div className="settings-modal-content editor-bridge-content">
          <div className={`editor-bridge-overview ${status?.running ? "online" : "offline"}`}>
            <div className="editor-bridge-overview-main">
              {status?.running ? <CheckCircle2 size={16} /> : <PlugZap size={16} />}
              <div>
                <strong>{status?.running ? "桥接已就绪" : "桥接未启动"}</strong>
                <span>
                  {status?.running
                    ? `127.0.0.1:${status.port} · 协议 v${status.protocolVersion}`
                    : "只有回环地址的本地连接，不对局域网开放"}
                </span>
              </div>
            </div>
            <button type="button" className="btn-icon" onClick={() => void refresh()} disabled={loading} title="重新检测">
              <RefreshCw size={15} className={loading ? "editor-bridge-spin" : undefined} />
            </button>
          </div>

          {error && <div className="editor-bridge-error">{error}</div>}

          <div className="editor-bridge-list">
            {installedTargets.map((target) => (
              <div className="editor-bridge-row" key={target.id}>
                <div className="editor-bridge-row-main">
                  <strong>{target.label}</strong>
                  <span>{targetStatusText(target)}</span>
                </div>
                <button
                  type="button"
                  className="filter-add-btn primary"
                  disabled={busyId === target.id || (target.kind === "extension" && !target.cliPath)}
                  onClick={() => void install(target)}
                >
                  {busyId === target.id && <LoaderCircle size={13} className="editor-bridge-spin" />}
                  {targetActionLabel(target)}
                </button>
              </div>
            ))}

            {!loading && installedTargets.length === 0 && (
              <div className="editor-bridge-empty">没有检测到已安装的编辑器。</div>
            )}

            {availableTargets.length > 0 && (
              <button
                type="button"
                className="editor-bridge-section-toggle"
                aria-expanded={addMenuOpen}
                onClick={() => setAddMenuOpen((open) => !open)}
              >
                {addMenuOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                未安装的编辑器
                <span className="editor-bridge-section-count">{availableTargets.length}</span>
              </button>
            )}

            {addMenuOpen && availableTargets.map((target) => (
              <div className="editor-bridge-row editor-bridge-row-muted" key={target.id}>
                <div className="editor-bridge-row-main">
                  <strong>{target.label}</strong>
                  <span>{target.kind === "config" ? "未检测到安装，仍可写入配置" : "未检测到安装"}</span>
                </div>
                <button
                  type="button"
                  className="filter-add-btn"
                  disabled={busyId === target.id}
                  onClick={() => void install(target)}
                >
                  {busyId === target.id && <LoaderCircle size={13} className="editor-bridge-spin" />}
                  {target.kind === "config" ? "写入配置" : "安装插件"}
                </button>
              </div>
            ))}
          </div>

          {keymapSnippet && (
            <div className="editor-bridge-hint">
              <div className="editor-bridge-hint-head">
                <span>Zed 已有自定义键位，没有改动它</span>
                <button type="button" className="editor-bridge-copy" onClick={() => void copyKeymapSnippet()}>
                  <Copy size={12} />
                  复制
                </button>
              </div>
              <p>把这段加进 keymap.json 的数组里，就能用 Ctrl+Alt+H：</p>
              <pre>{keymapSnippet}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
