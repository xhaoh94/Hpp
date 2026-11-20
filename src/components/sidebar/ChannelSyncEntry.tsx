import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cloud,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import type { AgentConfigExportData } from "@shared/agent-config-io";
import {
  CHANNEL_SYNC_DEFAULT_DEPLOY_PATH,
  CHANNEL_SYNC_DEFAULT_IMAGE,
  CHANNEL_SYNC_DEFAULT_PORT,
  countChannelSyncProviders,
  describeChannelSyncTargetStatus,
  formatChannelSyncTimestamp,
} from "@shared/channel-sync";
import type {
  ChannelSyncProbeResult,
  ChannelSyncStatus,
  ChannelSyncTargetInput,
  ChannelSyncTargetView,
} from "@/types";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import "./Settings.css";

type ChannelSyncEntryProps = {
  /** 收集所有 Agent 的全部渠道（含 API Key）；由宿主复用已有的读取逻辑。 */
  collectPayload: () => Promise<AgentConfigExportData>;
  /** 拉取成功：宿主负责打开冲突确认界面，确认后才写本地配置。 */
  onPulled: (data: AgentConfigExportData) => void | Promise<void>;
};

/** 只用于错误：成功类操作一律飘字，不再占界面底部。 */
type Notice = { text: string };

type PendingBackup = {
  payload: AgentConfigExportData;
  agentCount: number;
  providerCount: number;
};

type DeploySession = {
  targetId: string;
  running: boolean;
  phase: string;
  logs: string[];
};

type EditorState = {
  targetId?: string;
  name: string;
  host: string;
  sshPort: string;
  sshUser: string;
  password: string;
  servicePort: string;
  deployPath: string;
  image: string;
  probe: ChannelSyncProbeResult | null;
  testing: boolean;
  saving: boolean;
  error: string;
};

const emptyEditor = (): EditorState => ({
  name: "",
  host: "",
  sshPort: "22",
  sshUser: "root",
  password: "",
  servicePort: String(CHANNEL_SYNC_DEFAULT_PORT),
  deployPath: CHANNEL_SYNC_DEFAULT_DEPLOY_PATH,
  image: CHANNEL_SYNC_DEFAULT_IMAGE,
  probe: null,
  testing: false,
  saving: false,
  error: "",
});

function editorFromTarget(target: ChannelSyncTargetView): EditorState {
  return {
    ...emptyEditor(),
    targetId: target.id,
    name: target.name,
    host: target.host,
    sshPort: String(target.sshPort),
    sshUser: target.sshUser,
    servicePort: String(target.servicePort),
    deployPath: target.deployPath,
    image: target.image,
  };
}

function statusClass(status: ChannelSyncTargetView["lastStatus"]): string {
  switch (status) {
    case "running":
      return "running";
    case "stopped":
      return "warning";
    case "no_docker":
    case "no_sudo":
    case "unreachable":
      return "error";
    default:
      return "muted";
  }
}

/**
 * 渠道配置同步入口（渠道配置服务器）。
 *
 * 一台服务器是一个「目标」：可以添加多台，同一时间只有一台是当前目标。
 * 部署 / 检查 / 备份 / 拉取全部由用户点击触发，没有后台轮询。
 */
export function ChannelSyncEntry({ collectPayload, onPulled }: ChannelSyncEntryProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [targets, setTargets] = useState<ChannelSyncTargetView[]>([]);
  const [status, setStatus] = useState<ChannelSyncStatus | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState("");
  const [pendingBackup, setPendingBackup] = useState<PendingBackup | null>(null);
  const [deploySession, setDeploySession] = useState<DeploySession | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [undeployTarget, setUndeployTarget] = useState<ChannelSyncTargetView | null>(null);
  const [undeployPassword, setUndeployPassword] = useState("");
  const [undeployRemoveData, setUndeployRemoveData] = useState(false);
  const [undeployError, setUndeployError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showUndeployPassword, setShowUndeployPassword] = useState(false);

  const activeTarget = useMemo(
    () => targets.find((target) => target.isActive) || targets[0],
    [targets],
  );

  const refresh = useCallback(async () => {
    const [list, nextStatus] = await Promise.all([
      window.electronAPI.channelSyncListTargets(),
      window.electronAPI.channelSyncGetStatus(),
    ]);
    setTargets(list || []);
    setStatus(nextStatus);
  }, []);

  const ensureBridge = useCallback((): boolean => {
    if (typeof window.electronAPI.channelSyncListTargets === "function") return true;
    setNotice({ text: "当前进程缺少同步接口，重启 Hpp 后再试。" });
    return false;
  }, []);

  const handleOpen = useCallback(async () => {
    setOpen(true);
    setNotice(null);
    setPendingBackup(null);
    setDeploySession(null);
    if (!ensureBridge()) return;
    setLoading(true);
    try {
      await refresh();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [ensureBridge, refresh]);

  // 部署进度由主进程推送，按 targetId 归入当前会话。
  useEffect(() => {
    if (typeof window.electronAPI.onChannelSyncDeployProgress !== "function") return;
    return window.electronAPI.onChannelSyncDeployProgress((event) => {
      setDeploySession((current) => {
        if (!current || current.targetId !== event.targetId) return current;
        return {
          ...current,
          phase: event.phase,
          logs: [...current.logs, event.message].slice(-200),
        };
      });
    });
  }, []);

  const runDeploy = useCallback(
    async (targetId: string, password?: string) => {
      setBusyId(`deploy:${targetId}`);
      setNotice(null);
      setDeploySession({ targetId, running: true, phase: "connecting", logs: ["开始部署…"] });
      try {
        const result = await window.electronAPI.channelSyncDeployTarget(targetId, password);
        setDeploySession((current) =>
          current && current.targetId === targetId ? { ...current, running: false } : current,
        );
        await refresh();
        if (result.success) {
          showFloatingToastMessage("部署完成，服务已就绪");
        } else {
          setNotice({ text: result.error || "部署失败" });
        }
      } catch (error) {
        setDeploySession((current) =>
          current && current.targetId === targetId ? { ...current, running: false } : current,
        );
        setNotice({ text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusyId("");
      }
    },
    [refresh],
  );

  const handleDeploy = useCallback(
    async (target: ChannelSyncTargetView) => {
      if (!target.hasPassword) {
        setShowPassword(false);
        setEditor(editorFromTarget(target));
        setNotice({ text: "这个目标还没有保存 SSH 密码，先填写再部署。" });
        return;
      }
      await runDeploy(target.id);
    },
    [runDeploy],
  );

  const handleCheck = useCallback(
    async (target: ChannelSyncTargetView) => {
      setBusyId(`check:${target.id}`);
      setNotice(null);
      try {
        const result = await window.electronAPI.channelSyncCheckTarget(
          target.id,
          target.hasPassword ? undefined : "",
        );
        await refresh();
        if (result.success) {
          showFloatingToastMessage(
            `状态：${describeChannelSyncTargetStatus(result.status)}${result.revision ? `，第 ${result.revision} 版` : ""}`,
          );
        } else {
          setNotice({
            text: result.error || `状态：${describeChannelSyncTargetStatus(result.status)}`,
          });
        }
      } finally {
        setBusyId("");
      }
    },
    [refresh],
  );

  const handleSetActive = useCallback(
    async (target: ChannelSyncTargetView) => {
      // 切换期间锁住交互，避免连点导致 status 与卡片高亮错位。
      setBusyId(`switch:${target.id}`);
      setNotice(null);
      try {
        const result = await window.electronAPI.channelSyncSetActiveTarget(target.id);
        if (!result.success) {
          setNotice({ text: result.error || "切换失败" });
          return;
        }
        await refresh();
      } finally {
        setBusyId("");
      }
    },
    [refresh],
  );

  const handleRemove = useCallback(
    async (target: ChannelSyncTargetView) => {
      const result = await window.electronAPI.channelSyncRemoveTarget(target.id);
      if (!result.success) {
        setNotice({ text: result.error || "删除失败" });
        return;
      }
      await refresh();
      showFloatingToastMessage(`已删除目标「${target.name}」`);
    },
    [refresh],
  );

  const handleUndeploy = useCallback(async () => {
    if (!undeployTarget) return;
    const target = undeployTarget;
    setBusyId(`undeploy:${target.id}`);
    setNotice(null);
    setUndeployError("");
    try {
      const result = await window.electronAPI.channelSyncUndeployTarget(target.id, {
        ...(undeployPassword ? { password: undeployPassword } : {}),
        removeData: undeployRemoveData,
      });
      if (!result.success) {
        setUndeployError(result.error || "卸载失败");
        return;
      }
      await refresh();
      setUndeployTarget(null);
      setUndeployPassword("");
      showFloatingToastMessage(
        undeployRemoveData
          ? "已删除容器和部署目录"
          : "已删除容器，data/ 里的备份仍然保留",
      );
      setUndeployRemoveData(false);
    } finally {
      setBusyId("");
    }
  }, [undeployPassword, undeployRemoveData, undeployTarget, refresh]);

  const handleTrustFingerprint = useCallback(
    async (target: ChannelSyncTargetView) => {
      const result = await window.electronAPI.channelSyncClearFingerprint(target.id);
      if (!result.success) {
        setNotice({ text: result.error || "清除失败" });
        return;
      }
      await refresh();
      showFloatingToastMessage("已清除主机指纹，下次连接会重新记录");
    },
    [refresh],
  );

  const handlePrepareBackup = useCallback(async () => {
    setNotice(null);
    setPendingBackup(null);
    setBusyId("collect");
    try {
      const payload = await collectPayload();
      const stats = countChannelSyncProviders(payload);
      if (stats.providerCount === 0) {
        setNotice({ text: "当前没有可备份的渠道。" });
        return;
      }
      setPendingBackup({ payload, ...stats });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId("");
    }
  }, [collectPayload]);

  const handleConfirmBackup = useCallback(async () => {
    if (!pendingBackup) return;
    setBusyId("backup");
    setNotice(null);
    try {
      const result = await window.electronAPI.channelSyncBackup(pendingBackup.payload);
      if (!result.success) {
        setNotice({ text: result.error || "备份失败" });
        return;
      }
      setPendingBackup(null);
      await refresh();
      showFloatingToastMessage(
        `已备份 ${result.providerCount} 个渠道到服务器（第 ${result.revision ?? "?"} 版）`,
      );
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId("");
    }
  }, [pendingBackup, refresh]);

  const handlePull = useCallback(async () => {
    setBusyId("pull");
    setNotice(null);
    setPendingBackup(null);
    try {
      const result = await window.electronAPI.channelSyncPull();
      if (!result.success || !result.data) {
        setNotice({ text: result.error || "拉取失败" });
        return;
      }
      await refresh();
      setOpen(false);
      await onPulled(result.data);
      showFloatingToastMessage(
        `已拉取服务器第 ${result.snapshot?.revision ?? "?"} 版，请确认冲突后导入`,
      );
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId("");
    }
  }, [onPulled, refresh]);

  const persistEditor = useCallback(async (): Promise<string | null> => {
    if (!editor) return null;
    const input: ChannelSyncTargetInput = {
      ...(editor.targetId ? { id: editor.targetId } : {}),
      name: editor.name.trim() || editor.host.trim(),
      host: editor.host.trim(),
      sshPort: Number(editor.sshPort),
      sshUser: editor.sshUser.trim(),
      servicePort: Number(editor.servicePort),
      deployPath: editor.deployPath.trim(),
      image: editor.image.trim(),
      ...(editor.password ? { password: editor.password } : {}),
    };
    const result = await window.electronAPI.channelSyncSaveTarget(input);
    if (!result.success || !result.target) {
      setEditor((current) => (current ? { ...current, error: result.error || "保存失败" } : current));
      return null;
    }
    const savedId = result.target.id;
    // 新建后立即把 id 写回编辑器：否则「测试连接」创建一条、
    // 随后「保存并部署」又创建一条，列表里会出现两个同名目标。
    setEditor((current) => (current && !current.targetId ? { ...current, targetId: savedId } : current));
    await refresh();
    return savedId;
  }, [editor, refresh]);

  const handleTest = useCallback(async () => {
    if (!editor) return;
    setEditor((current) => (current ? { ...current, testing: true, error: "", probe: null } : current));
    try {
      const targetId = await persistEditor();
      if (!targetId) return;
      const probe = await window.electronAPI.channelSyncProbeTarget(
        targetId,
        editor.password || undefined,
      );
      setEditor((current) =>
        current
          ? {
              ...current,
              testing: false,
              probe,
              error: probe.success ? "" : probe.error || "连接失败",
            }
          : current,
      );
      await refresh();
    } catch (error) {
      setEditor((current) =>
        current
          ? {
              ...current,
              testing: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }, [editor, persistEditor, refresh]);

  const handleSave = useCallback(async () => {
    setEditor((current) => (current ? { ...current, saving: true, error: "" } : current));
    const targetId = await persistEditor();
    setEditor((current) => (current ? { ...current, saving: false } : current));
    if (targetId) {
      setEditor(null);
      showFloatingToastMessage("目标已保存");
    }
  }, [persistEditor]);

  const handleSaveAndDeploy = useCallback(async () => {
    setEditor((current) => (current ? { ...current, saving: true, error: "" } : current));
    const targetId = await persistEditor();
    setEditor((current) => (current ? { ...current, saving: false } : current));
    if (!targetId) return;
    setEditor(null);
    await runDeploy(targetId, editor?.password || undefined);
  }, [editor, persistEditor, runDeploy]);

  const busyAny = busyId !== "";
  const revisionText = status?.lastBackupRevision
    ? `第 ${status.lastBackupRevision} 版`
    : "服务器上还没有备份";

  return (
    <>
      <button
        type="button"
        className="btn-action agent-config-io-entry-btn"
        onClick={() => void handleOpen()}
        title="通过服务器备份 / 拉取渠道配置"
      >
        <Cloud size={14} />
        同步
      </button>

      {open && (
        <div
          className="settings-modal-overlay agent-config-io-overlay"
          onMouseDown={() => {
            if (!busyAny) setOpen(false);
          }}
        >
          <div
            className="settings-modal agent-config-io-modal channel-sync-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div>
                <h3>渠道配置同步</h3>
                <div className="agent-config-subtitle">
                  部署到渠道配置服务器、检查状态，再手动备份或拉取渠道配置
                </div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setOpen(false)}
                disabled={busyAny}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>

            <div className="settings-modal-content agent-config-io-content channel-sync-scroll">
              {loading ? (
                <div className="agent-config-empty">正在读取同步配置...</div>
              ) : (
                <>
                  <div className="channel-sync-section-head">
                    <strong>渠道配置服务器</strong>
                    <button
                      type="button"
                      className="channel-sync-add"
                      onClick={() => {
                        setShowPassword(false);
                        setEditor(emptyEditor());
                      }}
                      disabled={busyAny}
                    >
                      <Plus size={13} /> 添加服务器
                    </button>
                  </div>

                  {targets.length === 0 ? (
                    <div className="channel-sync-hint">
                      还没有服务器。点「添加服务器」填写地址和 SSH 账号，Hpp 会把同步服务部署上去。
                    </div>
                  ) : (
                    <div className="channel-sync-targets">
                      {targets.map((target) => {
                        const deploying =
                          busyId === `deploy:${target.id}` ||
                          (deploySession?.targetId === target.id && deploySession.running);
                        return (
                          <div
                            key={target.id}
                            className={`channel-sync-target ${target.isActive ? "active" : ""}`}
                            // 整张卡片就是选择器：点哪个切哪个，不用再找小按钮。
                            role="button"
                            tabIndex={0}
                            aria-pressed={target.isActive}
                            title={
                              target.isActive
                                ? `${target.name}（当前目标）`
                                : `切换为当前目标：${target.name}`
                            }
                            onClick={() => {
                              if (!target.isActive && !busyAny) void handleSetActive(target);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              if (!target.isActive && !busyAny) void handleSetActive(target);
                            }}
                          >
                            <div className="channel-sync-target-title">
                              {target.isActive ? (
                                <CheckCircle2 size={14} className="channel-sync-target-active-icon" />
                              ) : (
                                <Server size={14} />
                              )}
                              <strong
                                title={`${target.name} · ${target.sshUser}@${target.host}:${target.sshPort}`}
                              >
                                {target.name}
                              </strong>
                              <span
                                className={`channel-sync-badge ${statusClass(target.lastStatus)}`}
                                title={
                                  target.lastCheckAt
                                    ? `检查于 ${formatChannelSyncTimestamp(target.lastCheckAt)}`
                                    : "还没有检查过"
                                }
                              >
                                {describeChannelSyncTargetStatus(target.lastStatus)}
                              </span>
                            </div>
                            <div className="channel-sync-target-row">
                              <div
                                className="channel-sync-target-actions"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="btn-action channel-sync-icon-btn"
                                  onClick={() => void handleDeploy(target)}
                                  disabled={busyAny}
                                  title={
                                    target.lastStatus === "not_deployed" ? "部署" : "重新部署"
                                  }
                                  aria-label={
                                    target.lastStatus === "not_deployed" ? "部署" : "重新部署"
                                  }
                                >
                                  {deploying ? (
                                    <Loader2 size={13} className="agent-config-spin" />
                                  ) : (
                                    <CloudUpload size={13} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="btn-action channel-sync-icon-btn"
                                  onClick={() => void handleCheck(target)}
                                  disabled={busyAny}
                                  title="检查状态"
                                  aria-label="检查状态"
                                >
                                  {busyId === `check:${target.id}` ? (
                                    <Loader2 size={13} className="agent-config-spin" />
                                  ) : (
                                    <RefreshCw size={13} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="btn-action channel-sync-icon-btn"
                                  onClick={() => {
                                    setShowPassword(false);
                                    setEditor(editorFromTarget(target));
                                    setNotice(null);
                                  }}
                                  disabled={busyAny}
                                  title="编辑"
                                  aria-label="编辑"
                                >
                                  <Pencil size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="btn-action channel-sync-icon-btn"
                                  onClick={() => {
                                    setUndeployTarget(target);
                                    setUndeployPassword("");
                                    setUndeployRemoveData(false);
                                    setUndeployError("");
                                    setShowUndeployPassword(false);
                                    setNotice(null);
                                  }}
                                  disabled={busyAny}
                                  title="卸载远程服务（删除服务器上的容器）"
                                  aria-label="卸载远程服务"
                                >
                                  {busyId === `undeploy:${target.id}` ? (
                                    <Loader2 size={13} className="agent-config-spin" />
                                  ) : (
                                    <CloudOff size={13} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="btn-action channel-sync-icon-btn channel-sync-danger"
                                  onClick={() => void handleRemove(target)}
                                  disabled={busyAny}
                                  title="移除本地记录（不影响服务器）"
                                  aria-label="移除本地记录"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>
                            {target.lastError && (
                              <div className="channel-sync-target-error">{target.lastError}</div>
                            )}
                            {target.lastError && target.lastStatus === "unreachable" && (
                              <button
                                type="button"
                                className="channel-sync-link"
                                onClick={() => void handleTrustFingerprint(target)}
                                disabled={busyAny}
                              >
                                <ShieldAlert size={12} />
                                清除主机指纹后重试
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}


                  <div className="channel-sync-section-head">
                    <strong>备份与拉取</strong>
                    {activeTarget && (
                      <span className="channel-sync-section-hint">
                        当前目标：{activeTarget.name}（{activeTarget.serviceUrl}）
                      </span>
                    )}
                  </div>

                  <div className="channel-sync-status">
                    <div className="channel-sync-status-row">
                      <span>服务地址</span>
                      <strong>{status?.baseUrl || "未配置"}</strong>
                    </div>
                    <div className="channel-sync-status-row">
                      <span>服务 Token</span>
                      <strong>{status?.tokenSet ? status.tokenPreview || "已保存" : "未保存"}</strong>
                    </div>
                    <div className="channel-sync-status-row">
                      <span>服务器备份</span>
                      <strong>
                        {revisionText}
                        {status?.lastBackupAt
                          ? ` · ${formatChannelSyncTimestamp(status.lastBackupAt)}`
                          : ""}
                      </strong>
                    </div>
                    {status?.lastPullAt && (
                      <div className="channel-sync-status-row">
                        <span>上次拉取</span>
                        <strong>{formatChannelSyncTimestamp(status.lastPullAt)}</strong>
                      </div>
                    )}
                  </div>

                  {status && !status.tokenSet && (
                    <div className="channel-sync-hint">
                      服务 Token 还没有保存。点目标上的「重新部署」，Hpp 会生成并保存新的 Token。
                    </div>
                  )}

                  <div className="channel-sync-actions">
                    <button
                      type="button"
                      className="channel-sync-action"
                      onClick={() => void handlePrepareBackup()}
                      disabled={busyAny || !status?.configured}
                    >
                      {busyId === "backup" ? (
                        <Loader2 size={18} className="agent-config-spin" />
                      ) : (
                        <CloudUpload size={18} />
                      )}
                      <span>
                        <strong>备份到服务器</strong>
                        <small>上传当前所有 Agent 的渠道（含 API Key）</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="channel-sync-action"
                      onClick={() => void handlePull()}
                      disabled={busyAny || !status?.configured}
                    >
                      {busyId === "pull" ? (
                        <Loader2 size={18} className="agent-config-spin" />
                      ) : (
                        <CloudDownload size={18} />
                      )}
                      <span>
                        <strong>从服务器拉取</strong>
                        <small>下载最新备份，确认冲突后才写入本地</small>
                      </span>
                    </button>
                  </div>

                  {notice && (
                    <div className="status-message error channel-sync-notice">{notice.text}</div>
                  )}

                </>
              )}
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div
          className="settings-modal-overlay agent-config-io-overlay"
          onMouseDown={() => {
            if (!editor.saving && !editor.testing) setEditor(null);
          }}
        >
          <div
            className="settings-modal agent-config-io-modal channel-sync-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div>
                <h3>{editor.targetId ? "编辑服务器" : "添加服务器"}</h3>
                <div className="agent-config-subtitle">
                  填写 SSH 账号后先「测试连接」，确认环境再部署
                </div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setEditor(null)}
                disabled={editor.saving || editor.testing}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>

            <div className="settings-modal-content agent-config-io-content channel-sync-scroll">
              <div className="channel-sync-form-grid">
                <label className="channel-sync-field">
                  <span>名称</span>
                  <input
                    type="text"
                    value={editor.name}
                    placeholder="例如 主服务器"
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                  />
                </label>
                <label className="channel-sync-field">
                  <span>服务器地址</span>
                  <input
                    type="text"
                    value={editor.host}
                    placeholder="IP 或主机名"
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, host: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                    spellCheck={false}
                  />
                </label>
                <label className="channel-sync-field">
                  <span>SSH 端口</span>
                  <input
                    type="text"
                    value={editor.sshPort}
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, sshPort: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                    inputMode="numeric"
                  />
                </label>
                <label className="channel-sync-field">
                  <span>SSH 用户名</span>
                  <input
                    type="text"
                    value={editor.sshUser}
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, sshUser: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                    spellCheck={false}
                  />
                </label>
                <label className="channel-sync-field">
                  <span>SSH 密码</span>
                  <div className="channel-sync-password">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={editor.password}
                      placeholder={
                        editor.targetId ? "留空表示沿用已保存的密码" : "部署和检查时使用"
                      }
                      onChange={(event) =>
                        setEditor((current) =>
                          current ? { ...current, password: event.target.value } : current,
                        )
                      }
                      disabled={editor.saving || editor.testing}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="channel-sync-eye"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      title={showPassword ? "隐藏密码" : "显示密码"}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <small>密码用系统安全存储加密保存，不会写进日志。</small>
                </label>
                <label className="channel-sync-field">
                  <span>服务端口</span>
                  <input
                    type="text"
                    value={editor.servicePort}
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, servicePort: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                    inputMode="numeric"
                  />
                </label>
                <label className="channel-sync-field channel-sync-field-wide">
                  <span>部署目录</span>
                  <input
                    type="text"
                    value={editor.deployPath}
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, deployPath: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                    spellCheck={false}
                  />
                  <small>部署时自动创建；`data/` 里保留历史备份，重新部署不会丢。</small>
                </label>
                <label className="channel-sync-field channel-sync-field-wide">
                  <span>镜像</span>
                  <input
                    type="text"
                    value={editor.image}
                    onChange={(event) =>
                      setEditor((current) =>
                        current ? { ...current, image: event.target.value } : current,
                      )
                    }
                    disabled={editor.saving || editor.testing}
                    spellCheck={false}
                  />
                  <small>默认 node:22-alpine；服务器拉不动 Docker Hub 时填已有的 node 镜像。</small>
                </label>
              </div>

              {editor.probe && (
                <div className="channel-sync-probe">
                  <div>
                    <span>Docker</span>
                    <strong>{editor.probe.dockerVersion || "未检测到"}</strong>
                  </div>
                  <div>
                    <span>sudo</span>
                    <strong>{editor.probe.sudoAvailable ? "可用" : "不可用"}</strong>
                  </div>
                  <div>
                    <span>容器</span>
                    <strong>{describeChannelSyncTargetStatus(editor.probe.containerStatus || "unknown")}</strong>
                  </div>
                  <div>
                    <span>主机指纹</span>
                    <strong className="channel-sync-fingerprint">
                      {editor.probe.hostFingerprint || "未记录"}
                    </strong>
                  </div>
                </div>
              )}

              {editor.error && (
                <div className="status-message error channel-sync-editor-error">{editor.error}</div>
              )}

            </div>
            <div className="channel-sync-footer">
              <button
                type="button"
                className="btn-action"
                onClick={() => void handleTest()}
                disabled={editor.saving || editor.testing}
              >
                {editor.testing ? (
                  <Loader2 size={13} className="agent-config-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                测试连接
              </button>
              <button
                type="button"
                className="btn-action"
                onClick={() => void handleSave()}
                disabled={editor.saving || editor.testing}
              >
                保存
              </button>
              <button
                type="button"
                className="filter-add-btn"
                onClick={() => void handleSaveAndDeploy()}
                disabled={editor.saving || editor.testing}
              >
                {editor.saving ? (
                  <Loader2 size={13} className="agent-config-spin" />
                ) : (
                  <CloudUpload size={13} />
                )}
                保存并部署
              </button>
            </div>
          </div>
        </div>
      )}
      {undeployTarget && (
        <div
          className="settings-modal-overlay agent-config-io-overlay"
          onMouseDown={() => {
            if (busyId !== `undeploy:${undeployTarget.id}`) setUndeployTarget(null);
          }}
        >
          <div
            className="settings-modal agent-config-io-modal channel-sync-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div>
                <h3>卸载远程服务</h3>
                <div className="agent-config-subtitle">
                  {undeployTarget.name}（{undeployTarget.serviceUrl}）
                </div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setUndeployTarget(null)}
                disabled={busyId === `undeploy:${undeployTarget.id}`}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>

            <div className="settings-modal-content agent-config-io-content channel-sync-scroll">
              <div className="channel-sync-hint">
                将删除服务器上的容器 <code>hpp-channel-sync</code>，服务立即停止。
                本地目标记录会保留，随时可以重新部署。
              </div>

              <label className="channel-sync-checkbox">
                <input
                  type="checkbox"
                  checked={undeployRemoveData}
                  onChange={(event) => setUndeployRemoveData(event.target.checked)}
                  disabled={busyId === `undeploy:${undeployTarget.id}`}
                />
                <span>
                  同时删除部署目录 <code>{undeployTarget.deployPath}</code>
                  （包含 data/ 里的历史备份，不可恢复）
                </span>
              </label>

              {undeployError && (
                <div className="status-message error channel-sync-editor-error">{undeployError}</div>
              )}

              {!undeployTarget.hasPassword && (
                <label className="channel-sync-field">
                  <span>SSH 密码</span>
                  <div className="channel-sync-password">
                    <input
                      type={showUndeployPassword ? "text" : "password"}
                      value={undeployPassword}
                      onChange={(event) => setUndeployPassword(event.target.value)}
                      placeholder="这个目标还没有保存密码"
                      disabled={busyId === `undeploy:${undeployTarget.id}`}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="channel-sync-eye"
                      onClick={() => setShowUndeployPassword((value) => !value)}
                      aria-label={showUndeployPassword ? "隐藏密码" : "显示密码"}
                      title={showUndeployPassword ? "隐藏密码" : "显示密码"}
                      tabIndex={-1}
                    >
                      {showUndeployPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </label>
              )}
            </div>

            <div className="channel-sync-footer">
              <button
                type="button"
                className="btn-action"
                onClick={() => setUndeployTarget(null)}
                disabled={busyId === `undeploy:${undeployTarget.id}`}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-action channel-sync-danger"
                onClick={() => void handleUndeploy()}
                disabled={busyId === `undeploy:${undeployTarget.id}`}
              >
                {busyId === `undeploy:${undeployTarget.id}` ? (
                  <Loader2 size={13} className="agent-config-spin" />
                ) : (
                  <CloudOff size={13} />
                )}
                确认卸载
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingBackup && (
        <div
          className="settings-modal-overlay agent-config-io-overlay"
          onMouseDown={() => {
            if (busyId !== "backup") setPendingBackup(null);
          }}
        >
          <div
            className="settings-modal agent-config-io-modal channel-sync-confirm-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div>
                <h3>确认备份</h3>
                <div className="agent-config-subtitle">会覆盖服务器上的最新版本</div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setPendingBackup(null)}
                disabled={busyId === "backup"}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="settings-modal-content">
              <p className="channel-sync-confirm-text">
                将上传 <strong>{pendingBackup.agentCount}</strong> 个 Agent、
                <strong>{pendingBackup.providerCount}</strong> 个渠道，
                <strong>包含 API Key 明文</strong>。
              </p>
              <p className="channel-sync-confirm-text">确认覆盖服务器上的最新版本？</p>
            </div>
            <div className="channel-sync-footer">
              <button
                type="button"
                className="btn-action"
                onClick={() => setPendingBackup(null)}
                disabled={busyId === "backup"}
              >
                取消
              </button>
              <button
                type="button"
                className="filter-add-btn"
                onClick={() => void handleConfirmBackup()}
                disabled={busyId === "backup"}
              >
                {busyId === "backup" ? (
                  <Loader2 size={13} className="agent-config-spin" />
                ) : (
                  <CloudUpload size={13} />
                )}
                确认上传
              </button>
            </div>
          </div>
        </div>
      )}

      {deploySession && (
        <div
          className="settings-modal-overlay agent-config-io-overlay"
          onMouseDown={() => {
            if (!deploySession.running) setDeploySession(null);
          }}
        >
          <div
            className="settings-modal agent-config-io-modal channel-sync-log-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div>
                <h3>部署日志</h3>
                <div className="agent-config-subtitle">
                  {deploySession.running ? "正在部署，请稍候…" : "部署已结束"}
                </div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setDeploySession(null)}
                disabled={deploySession.running}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="settings-modal-content">
              <pre className="channel-sync-log-body">{deploySession.logs.join("\n")}</pre>
            </div>
            <div className="channel-sync-footer">
              <button
                type="button"
                className="btn-action"
                onClick={() => setDeploySession(null)}
                disabled={deploySession.running}
              >
                {deploySession.running ? "部署中…" : "关闭"}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
