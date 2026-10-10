import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Server, Trash2, X } from "lucide-react";
import {
  DEFAULT_MCP_EXPOSURE,
  MCP_EXPOSURES,
  isServerEnabled,
  resolveEffectiveExposure,
  resolveExposureAlias,
  validateMcpServerEntry,
  type McpExposure,
} from "@shared/agent-mcp-config";
import type { McpConfigScope, McpConfigSnapshot, McpServerConfig, McpServerEntry } from "@/types/ipc";
import "./Settings.css";

type AgentMcpModalProps = {
  agentName: string;
  /** MCP 总开关的当前值与切换回调（复用 AgentConfigModal 的 builtinExtension 通道）。 */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  /** Codemode 总开关的当前值，用于提示「server 用 codemode 档但 codemode 没开」。 */
  codemodeEnabled?: boolean;
  /** 可选项目列表，用于项目级配置。没有项目时只显示全局。 */
  projects: Array<{ id: string; name: string; path: string }>;
  onClose: () => void;
};

type DraftEntry = {
  /**
   * 稳定标识，**不随改名变化**。
   * 列表 key 用它而不是 name —— 否则每敲一个字符 key 就变，React 会卸载重建整个条目，
   * 展开状态下改了一半的输入会丢。
   */
  id: string;
  name: string;
  config: McpServerConfig;
  isOverride: boolean;
  overrideMissing: boolean;
  /** 覆盖条目必须指向哪个全局 server。 */
  overrideTarget?: string;
};

/** 单调递增的临时 id：同一弹窗会话内唯一就够，不必用 uuid。 */
let draftIdSeq = 0;
const nextDraftId = () => {
  draftIdSeq += 1;
  return `draft-${draftIdSeq}`;
};

const EXPOSURE_LABELS: Record<McpExposure, string> = {
  direct: "直接暴露",
  codemode: "仅脚本可调",
  deferred: "延迟加载",
  hidden: "隐藏",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 判断一条配置走哪个表单分支。url 有值就是 http，否则 stdio。 */
const isHttpConfig = (config: McpServerConfig): boolean =>
  typeof config.url === "string" && config.url.trim().length > 0;

/**
 * 表单里 exposure 的当前值。
 * 两个必须做的处理：缺省时显示**生效**档位（pi 的默认是 `codemode`，不是 `direct`），
 * 旧别名要显示成归一后的名字 —— 否则 select 的 value 落在一组 option 之外，界面空白。
 */
const exposureFormValue = (
  config: McpServerConfig,
  fallback: string = DEFAULT_MCP_EXPOSURE,
): string =>
  typeof config.exposure === "string" ? String(resolveExposureAlias(config.exposure) ?? fallback) : fallback;

function toDraft(entry: McpServerEntry): DraftEntry {
  return {
    id: nextDraftId(),
    name: entry.name,
    config: { ...entry.config },
    isOverride: entry.isOverride,
    overrideMissing: entry.overrideMissing,
    overrideTarget: entry.isOverride ? entry.name : undefined,
  };
}

function emptyHttpDraft(): McpServerConfig {
  return { url: "", type: "http" };
}

function emptyStdioDraft(): McpServerConfig {
  return { command: "", type: "stdio" };
}

/**
 * 解析高级 JSON 文本。返回 null 表示内容为空（表示「删掉这个条目」）。
 * 解析失败时抛Error，由调用方展示。
 */
function parseAdvancedJson(text: string): McpServerConfig | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) throw new Error("JSON 必须是一个对象");
  return parsed as McpServerConfig;
}

export function AgentMcpModal({
  agentName,
  enabled,
  onEnabledChange,
  codemodeEnabled = false,
  onClose,
  projects,
}: AgentMcpModalProps) {
  const [scope, setScope] = useState<McpConfigScope>("global");
  // 项目级编辑的目标项目；未选时用当前 activeProject（由调用方保证列表非空时至少有一条）。
  const [projectId, setProjectId] = useState("");
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [globalSnapshot, setGlobalSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // 展开的条目 id（不是 name —— 改名会改 name，用它会在改名瞬间折叠/展开错位）。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedText, setAdvancedText] = useState("");
  const [advancedError, setAdvancedError] = useState("");
  // mcp.json 的顶层字段，不属于任何 server。缺省 true（pi 的默认），未落盘时
  // 用true —— 与 pi 的 loadMcpConfig 一致（不存在时才return 不含该字段）。
  const [autoEnableCodemode, setAutoEnableCodemode] = useState(true);

  const project = useMemo(
    () => projects.find((item) => item.id === projectId) || projects[0],
    [projects, projectId],
  );
  const projectPath = scope === "project" ? project?.path : undefined;
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const loadScopeRequestRef = useRef(0);

  const readSnapshot = useCallback(async (nextScope: McpConfigScope, nextProjectPath?: string) => {
    const result = await window.electronAPI.agentMcpReadConfig(nextScope, nextProjectPath);
    if (!result.success || !result.snapshot) {
      throw new Error(result.error || "读取 MCP 配置失败");
    }
    return result.snapshot;
  }, []);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  const loadScope = useCallback(async (nextScope: McpConfigScope, nextProject?: { path: string }) => {
    const requestId = loadScopeRequestRef.current + 1;
    loadScopeRequestRef.current = requestId;
    const isCurrentRequest = () => loadScopeRequestRef.current === requestId;
    setLoading(true);
    setStatus(null);
    try {
      const next = await readSnapshot(nextScope, nextScope === "project" ? nextProject?.path : undefined);
      if (!isCurrentRequest()) return;
      let nextGlobalSnapshot: McpConfigSnapshot | null = null;
      if (nextScope === "global") {
        nextGlobalSnapshot = next;
      } else {
        // 每次进入项目级都重新读取全局配置，避免刚在全局新增/删除 server 后
        // 仍使用旧的覆盖目标列表和旧的 exposure 继承状态。
        nextGlobalSnapshot = await readSnapshot("global");
        if (!isCurrentRequest()) return;
      }
      setSnapshot(next);
      setDrafts(next.servers.map(toDraft));
      setGlobalSnapshot(nextGlobalSnapshot);
      // 顶层字段是全局的；项目级文件没有该字段时保留当前全局值。
      if (typeof nextGlobalSnapshot.autoEnableCodemode === "boolean") {
        setAutoEnableCodemode(nextGlobalSnapshot.autoEnableCodemode);
      }
      dirtyRef.current = false;
    } catch (error) {
      if (!isCurrentRequest()) return;
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
      setSnapshot(null);
      setDrafts([]);
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [readSnapshot]);

  useEffect(() => {
    void loadScope(scope, project);
    // 切作用域/切项目才重读；drafts 的改动不走这里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, project?.path]);

  // 按稳定 id 匹配而不是 name：改名过程中 name 会变，按 name 匹配会漏掉正在编辑的那一条。
  const setDraftField = (id: string, patch: Partial<DraftEntry>) => {
    dirtyRef.current = true;
    setDrafts((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const setConfigField = (id: string, patch: Partial<McpServerConfig>) => {
    dirtyRef.current = true;
    setDrafts((current) => current
      .map((item) => (item.id === id ? { ...item, config: { ...item.config, ...patch } } : item)));
  };

  const handleToggleEnabled = async (next: boolean) => {
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

  const handleAdd = (kind: "stdio" | "http" | "override") => {
    const used = new Set(drafts.map((item) => item.name));
    // 覆盖条目的名字必须等于全局 server 名，所以先留空、由用户选「覆盖目标」时确定。
    let name = "";
    if (kind !== "override") {
      name = kind === "stdio" ? "new-stdio-server" : "new-http-server";
      let index = 1;
      while (used.has(name)) {
        name = `${kind}-server-${index}`;
        index += 1;
      }
    }
    dirtyRef.current = true;
    const id = nextDraftId();
    setDrafts((current) => [
      ...current,
      {
        id,
        name,
        config: kind === "stdio" ? emptyStdioDraft() : kind === "http" ? emptyHttpDraft() : { enabled: true },
        isOverride: kind === "override",
        overrideMissing: kind === "override",
        overrideTarget: kind === "override" ? "" : undefined,
      },
    ]);
    setEditingId(id);
    setAdvancedOpen(false);
  };

  const handleRemove = (id: string) => {
    dirtyRef.current = true;
    setDrafts((current) => current.filter((item) => item.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setAdvancedOpen(false);
    }
  };

  const handleRename = (id: string, to: string) => {
    const next = to.trim();
    if (!next || next === drafts.find((item) => item.id === id)?.name) return;
    if (drafts.some((item) => item.name === next)) {
      setStatus({ type: "error", text: `已存在名为 ${next} 的 server` });
      return;
    }
    dirtyRef.current = true;
    // 只改 name，id 不变 —— 改了就会在输入过程中重挂载、把改了一半的表单冲掉。
    setDrafts((current) => current.map((item) => (item.id === id ? { ...item, name: next } : item)));
  };

  const handleApplyAdvanced = (id: string) => {
    try {
      const parsed = parseAdvancedJson(advancedText);
      setAdvancedError("");
      if (parsed === null) {
        handleRemove(id);
        setEditingId(null);
        return;
      }
      setConfigField(id, parsed);
      setAdvancedError("");
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSave = async () => {
    if (savingRef.current) return;
    // 先本地校验，给出精确到条目的错误；pi 那边只会笼统地拒绝加载。
    const errors: string[] = [];
    const seen = new Set<string>();
    const globalNames = new Set((globalSnapshot?.servers || []).map((item) => item.name));
    for (const draft of drafts) {
      const name = draft.name.trim();
      if (!name) {
        errors.push("存在未命名的 server");
        continue;
      }
      if (seen.has(name)) {
        errors.push(`server "${name}" 重复`);
        continue;
      }
      seen.add(name);
      // 按**当前作用域**校验，不是按条目的性质：项目文件里的完整定义也要过项目级规则
      // （例如禁止自带 auth），否则错误要等主进程二次校验才报出来，报错点就变远了。
      if (scope === "project" && draft.isOverride && !globalNames.has(draft.overrideTarget || name)) {
        errors.push(`server "${name}" 的覆盖目标「${draft.overrideTarget || name}」在全局配置里不存在`);
        continue;
      }
      const error = validateMcpServerEntry(name, draft.config, scope);
      if (error) errors.push(error);
    }
    if (errors.length > 0) {
      setStatus({ type: "error", text: errors[0] });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setStatus(null);
    try {
      const servers: Record<string, McpServerConfig> = {};
      for (const draft of drafts) {
        servers[draft.name.trim()] = draft.config;
      }
      const result = await window.electronAPI.agentMcpWriteConfig(
        scope,
        {
          servers,
          // autoEnableCodemode 是**全局**顶层字段（pi 的语义是项目级覆盖全局，
          // config.js:112）。项目级保存时必须传 undefined —— 否则会在项目文件里
          // 钉一份当前全局值的副本，之后改全局设置时被这份陈旧副本反向盖掉。
          ...(scope === "global" ? { autoEnableCodemode } : {}),
        },
        projectPath,
      );
      if (!result.success) {
        setStatus({ type: "error", text: result.error || "保存失败" });
        return;
      }
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setDrafts(result.snapshot.servers.map(toDraft));
      }
      dirtyRef.current = false;
      // 配置已落盘但重连失败时 result.success 仍为 true（文件是好的），
      // 错误信息在 error 里 —— 这两件事要分开说，不能混成「保存失败」。
      setStatus(
        result.error
          ? { type: "error", text: result.error }
          : {
              type: "success",
              text: result.reconnected
                ? "已保存，MCP server 已重连"
                : "已保存。新会话启动时生效。",
            },
      );
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const requestClose = useCallback(() => {
    if (savingRef.current) return;
    if (dirtyRef.current) {
      const confirmed = window.confirm("有未保存的 MCP 配置，确定关闭？");
      if (!confirmed) return;
    }
    onClose();
  }, [onClose]);

  const globalServerNames = (globalSnapshot?.servers || []).map((item) => item.name);
  const canEditProject = scope === "project" && !!projectPath;
  // 「有没有 server 走codemode 档」要按**合并后的有效值**判断：项目级覆盖条目的
  // exposure 常常是 undefined，此时生效的是全局同名 server 的值。只看自己的
  // exposure 会把它算成 direct，提示就漏了。
  const hasCodemodeExposure = (snapshot?.servers || []).some((entry) =>
    isServerEnabled(entry) && resolveEffectiveExposure(entry, globalSnapshot?.servers || []) === "codemode");

  return createPortal(
    <div
      className="settings-modal-overlay agent-mcp-modal-overlay"
      onMouseDown={(event) => {
        event.stopPropagation();
        requestClose();
      }}
    >
      <div
        className="settings-modal agent-mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${agentName} MCP 设置`}
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="agent-mcp-modal-title">
            <span className="settings-general-heading-icon"><Server size={16} /></span>
            <div>
              <h3>{agentName} MCP</h3>
              <p>
                {scope === "global" ? "全局配置：~/.pi/agent/mcp.json" : `项目配置：${projectPath || "未选择项目"}/.pi/mcp.json`}
              </p>
            </div>
          </div>
          <button type="button" className="settings-modal-close" onClick={requestClose} disabled={saving} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="settings-modal-content agent-mcp-modal-content">
          <section className="agent-mcp-section">
            <label className="agent-mcp-enabled-row">
              <input
                type="checkbox"
                checked={enabled}
                disabled={loading || toggling}
                onChange={(event) => void handleToggleEnabled(event.target.checked)}
              />
              <span>
                启用 MCP
                <small>
                  {enabled
                    ? "Pi 会读取下面的 server 配置并连接它们"
                    : "关闭后 Pi 不会加载 MCP 扩展，下面配置的 server 不会被连接"}
                </small>
              </span>
            </label>
          </section>

          <section className="agent-mcp-section">
            <div className="agent-mcp-scope-row">
              <div className="agent-mcp-scope-toggle" role="tablist" aria-label="配置作用域">
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === "global"}
                  className={scope === "global" ? "active" : ""}
                  onClick={() => setScope("global")}
                >
                  全局
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === "project"}
                  className={scope === "project" ? "active" : ""}
                  onClick={() => setScope("project")}
                  disabled={projects.length === 0}
                  title={projects.length === 0 ? "当前没有可用项目" : undefined}
                >
                  项目级
                </button>
              </div>
              {scope === "project" && projects.length > 0 && (
                <select
                  className="agent-mcp-project-select"
                  value={project?.id || ""}
                  onChange={(event) => setProjectId(event.target.value)}
                  aria-label="选择项目"
                >
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              )}
              <span className="agent-mcp-file-path" title={snapshot?.filePath || ""}>
                {snapshot?.exists ? "配置文件已存在" : "配置文件尚未创建，保存后生成"}
              </span>
            </div>

            {scope === "project" && (
              <p className="agent-mcp-hint">
                项目级条目只写 <code>enabled</code> / <code>exposure</code> / <code>toolExposure</code>，
                用于覆盖同名的全局 server（例如在某个仓库里关掉它）。其他字段仍由全局配置提供。
              </p>
            )}
          </section>

          {scope === "global" && (
            <section className="agent-mcp-section">
              <label className="agent-mcp-enabled-row agent-mcp-auto-codemode">
                <input
                  type="checkbox"
                  checked={autoEnableCodemode}
                  disabled={loading || saving}
                  onChange={(event) => {
                    setAutoEnableCodemode(event.target.checked);
                    dirtyRef.current = true;
                  }}
                />
                <span>
                  自动启用 Codemode
                  <small>
                    有 server 的 exposure 设为<code>仅脚本可调</code>时，Pi 会自动把 Codemode
                    加入工具列表。关掉它需要手动在配置里开Codemode。
                  </small>
                </span>
              </label>
              {hasCodemodeExposure && !codemodeEnabled && (
                <p className="agent-mcp-hint agent-mcp-codemode-warning">
                  当前有 server 的生效档位是「仅脚本可调」（未显式设置 exposure 的 server 默认就是这一档），
                  但 Codemode 扩展没启用 —— 这些工具模型调不到。
                </p>
              )}
              {hasCodemodeExposure && codemodeEnabled && !autoEnableCodemode && (
                <p className="agent-mcp-hint agent-mcp-codemode-warning">
                  自动启用 Codemode 已关闭：这些脚本类工具要自己把 Codemode 加进工具列表才调得到。
                </p>
              )}
              {hasCodemodeExposure && codemodeEnabled && autoEnableCodemode && (
                <p className="agent-mcp-hint">
                  当前有 server 使用「仅脚本可调」，这些工具只能从 Codemode 脚本里调用，
                  不会出现在模型的工具列表中。
                </p>
              )}
            </section>
          )}

          {loading ? (
            <div className="agent-mcp-empty">读取中...</div>
          ) : (
            <>
              {snapshot && snapshot.errors.length > 0 && (
                <div className="agent-mcp-errors">
                  {snapshot.errors.map((error) => (
                    <div key={error}>
                      <AlertTriangle size={13} />
                      <span>{error}</span>
                    </div>
                  ))}
                </div>
              )}

              {drafts.length === 0 ? (
                <div className="agent-mcp-empty">
                  {scope === "global" ? "还没有配置任何 MCP server" : "这个项目还没有覆盖任何全局 server"}
                </div>
              ) : (
                <div className="agent-mcp-server-list">
                  {drafts.map((draft) => {
                    const expanded = editingId === draft.id;
                    const error = draft.name.trim()
                      ? validateMcpServerEntry(draft.name.trim(), draft.config, scope)
                      : "请填写 server 名";
                    return (
                      <div key={draft.id} className="agent-mcp-server">
                        <div className="agent-mcp-server-head">
                          <button
                            type="button"
                            className="agent-mcp-server-toggle"
                            onClick={() => {
                              setEditingId(expanded ? null : draft.id);
                              setAdvancedOpen(false);
                              setAdvancedError("");
                            }}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span className="agent-mcp-server-name">{draft.name || "(未命名)"}</span>
                          </button>
                          <span className="agent-mcp-server-kind">
                            {draft.isOverride ? "覆盖全局" : isHttpConfig(draft.config) ? "HTTP" : "stdio"}
                          </span>
                          <button
                            type="button"
                            className="btn-action agent-mcp-server-delete"
                            onClick={() => handleRemove(draft.id)}
                            disabled={saving}
                            aria-label={`删除 ${draft.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>

                        {draft.overrideMissing && (
                          <div className="agent-mcp-warning">
                            <AlertTriangle size={13} />
                            <span>没有同名全局 server，这条覆盖不会生效</span>
                          </div>
                        )}

                        {expanded && (
                          <div className="agent-mcp-server-body">
                            <label className="agent-mcp-field">
                              <span>名称</span>
                              <input
                                type="text"
                                value={draft.name}
                                disabled={draft.isOverride || saving}
                                placeholder="my-server"
                                onChange={(event) => handleRename(draft.id, event.target.value)}
                              />
                            </label>

                            {draft.isOverride ? (
                              <>
                                <label className="agent-mcp-field">
                                  <span>覆盖目标</span>
                                  <select
                                    value={draft.overrideTarget || ""}
                                    disabled={saving}
                                    onChange={(event) => setDraftField(draft.id, {
                                      overrideTarget: event.target.value,
                                      name: event.target.value,
                                    })}
                                  >
                                    <option value="">选择一个全局 server</option>
                                    {globalServerNames.map((name) => (
                                      <option key={name} value={name}>{name}</option>
                                    ))}
                                  </select>
                                </label>
                                <label className="agent-mcp-field">
                                  <span>启用</span>
                                  <input
                                    type="checkbox"
                                    checked={draft.config.enabled !== false}
                                    disabled={saving}
                                    onChange={(event) => setConfigField(draft.id, { enabled: event.target.checked })}
                                  />
                                </label>
                                <label className="agent-mcp-field">
                                  <span>exposure</span>
                                  <select
                                    value={exposureFormValue(draft.config, "")}
                                    disabled={saving}
                                    onChange={(event) => setConfigField(draft.id, {
                                      exposure: (event.target.value || undefined) as McpExposure | undefined,
                                    })}
                                  >
                                    <option value="">（沿用全局）</option>
                                    {MCP_EXPOSURES.map((value) => (
                                      <option key={value} value={value}>{EXPOSURE_LABELS[value]}</option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            ) : isHttpConfig(draft.config) ? (
                              <>
                                <label className="agent-mcp-field">
                                  <span>URL</span>
                                  <input
                                    type="text"
                                    value={draft.config.url || ""}
                                    disabled={saving}
                                    placeholder="https://example.com/mcp"
                                    onChange={(event) => setConfigField(draft.id, { url: event.target.value })}
                                  />
                                </label>
                                <label className="agent-mcp-field">
                                  <span>exposure</span>
                                  <select
                                    value={exposureFormValue(draft.config)}
                                    disabled={saving}
                                    onChange={(event) => setConfigField(draft.id, {
                                      exposure: event.target.value as McpExposure,
                                    })}
                                  >
                                    {MCP_EXPOSURES.map((value) => (
                                      <option key={value} value={value}>{EXPOSURE_LABELS[value]}</option>
                                    ))}
                                  </select>
                                </label>
                                <label className="agent-mcp-field">
                                  <span>超时（秒）</span>
                                  <input
                                    type="number"
                                    min={1}
                                    value={draft.config.timeout ?? ""}
                                    disabled={saving}
                                    placeholder="60"
                                    onChange={(event) => setConfigField(draft.id, {
                                      timeout: event.target.value ? Number(event.target.value) : undefined,
                                    })}
                                  />
                                </label>
                              </>
                            ) : (
                              <>
                                <label className="agent-mcp-field">
                                  <span>命令</span>
                                  <input
                                    type="text"
                                    value={draft.config.command || ""}
                                    disabled={saving}
                                    placeholder="npx"
                                    onChange={(event) => setConfigField(draft.id, { command: event.target.value })}
                                  />
                                </label>
                                <label className="agent-mcp-field">
                                  <span>参数</span>
                                  <input
                                    type="text"
                                    value={(draft.config.args || []).join(" ")}
                                    disabled={saving}
                                    placeholder="-y @modelcontextprotocol/server-filesystem ."
                                    onChange={(event) => setConfigField(draft.id, {
                                      args: event.target.value.trim() ? event.target.value.trim().split(/\s+/) : undefined,
                                    })}
                                  />
                                </label>
                                <label className="agent-mcp-field">
                                  <span>exposure</span>
                                  <select
                                    value={exposureFormValue(draft.config)}
                                    disabled={saving}
                                    onChange={(event) => setConfigField(draft.id, {
                                      exposure: event.target.value as McpExposure,
                                    })}
                                  >
                                    {MCP_EXPOSURES.map((value) => (
                                      <option key={value} value={value}>{EXPOSURE_LABELS[value]}</option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            )}

                            {!draft.isOverride && (
                              <div className="agent-mcp-advanced">
                                <button
                                  type="button"
                                  className="agent-mcp-advanced-toggle"
                                  onClick={() => {
                                    const next = !advancedOpen;
                                    setAdvancedOpen(next);
                                    setAdvancedError("");
                                    if (next) {
                                      setAdvancedText(JSON.stringify(draft.config, null, 2));
                                    }
                                  }}
                                >
                                  {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  高级配置（headers / env / auth / toolExposure）
                                </button>
                                {advancedOpen && (
                                  <div className="agent-mcp-advanced-body">
                                    <textarea
                                      value={advancedText}
                                      spellCheck={false}
                                      disabled={saving}
                                      rows={8}
                                      onChange={(event) => setAdvancedText(event.target.value)}
                                    />
                                    <div className="agent-mcp-advanced-actions">
                                      <button
                                        type="button"
                                        className="btn-action"
                                        disabled={saving}
                                        onClick={() => handleApplyAdvanced(draft.id)}
                                      >
                                        应用到该条目
                                      </button>
                                      <span className="agent-mcp-advanced-note">
                                        留空并应用 = 删除该条目。字段与pi 的 mcp.json 一致。
                                      </span>
                                    </div>
                                    {advancedError && (
                                      <div className="agent-mcp-advanced-error">{advancedError}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {error && <div className="agent-mcp-field-error">{error}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {canEditProject && globalServerNames.length === 0 && (
                <p className="agent-mcp-hint">
                  全局配置还是空的。先在「全局」里加一个 server，项目级才能对它做覆盖。
                </p>
              )}
            </>
          )}

          {status && (
            <div className={`agent-mcp-status ${status.type}`}>{status.text}</div>
          )}
        </div>

        <div className="agent-mcp-footer">
          <div className="agent-mcp-add-actions">
            <button type="button" className="btn-action" onClick={() => handleAdd("stdio")} disabled={loading || saving}>
              <Plus size={13} />
              stdio server
            </button>
            <button type="button" className="btn-action" onClick={() => handleAdd("http")} disabled={loading || saving}>
              <Plus size={13} />
              HTTP server
            </button>
            {scope === "project" && globalServerNames.length > 0 && (
              <button type="button" className="btn-action" onClick={() => handleAdd("override")} disabled={loading || saving}>
                <Plus size={13} />
                覆盖全局 server
              </button>
            )}
          </div>
          <div className="agent-mcp-footer-main">
            <button type="button" className="btn-action" onClick={requestClose} disabled={saving}>
              关闭
            </button>
            <button type="button" className="btn-primary agent-mcp-save" onClick={() => void handleSave()} disabled={saving || loading}>
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
