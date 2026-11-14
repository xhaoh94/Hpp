import { useEffect, useState } from "react";
import { GitBranch, Search } from "lucide-react";
import type { ProjectSession } from "@/stores/project-store";
import { isUserSpeechMessage, type ChatMessage } from "@/stores/chat-store";
import { getAgentName } from "@/lib/agents";
import { getSessionPreviewLabel } from "@/lib/chat-message-preview";
import { showFloatingToastMessage } from "@/lib/floating-toast";
import type { SessionSearchHit } from "../../../shared/session-export";
import { AttachmentPreviewText } from "@/components/shared/AttachmentPreviewText";
import "./SessionHistory.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sessions: ProjectSession[];
  sessionMessages: Record<string, ChatMessage[]>;
  /** 本项目的全部会话（含打开中的）：搜索按它收口，并用于解析命中项标题。 */
  allSessions?: ProjectSession[];
  projectName?: string;
  onResume: (session: ProjectSession) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
  onDeleteAll: () => void | Promise<void>;
}

type DeleteTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "all" };

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    if (isToday) return `今天 ${time}`;
    if (isYesterday) return `昨天 ${time}`;
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) + " " + time;
  } catch {
    return timestamp;
  }
}

const isForkedSession = (session: ProjectSession) => !!(session.forkedFrom || session.forkContext);

const stripForkTitlePrefix = (title: string) =>
  title.replace(/^(兼容分叉|分叉)\s*-\s*/u, "").trim();

const getSessionPreviewText = (
  session: ProjectSession,
  sessionMessages: Record<string, ChatMessage[]>
) => {
  if (isForkedSession(session)) {
    return stripForkTitlePrefix(session.title) || session.title;
  }

  const msgs = sessionMessages[session.id];
  const firstUserMsg = msgs?.find((m) => isUserSpeechMessage(m));
  const preview = firstUserMsg ? getSessionPreviewLabel(firstUserMsg) : "";
  return preview || session.preview || session.title;
};

export function SessionHistoryModal({ isOpen, onClose, sessions, sessionMessages, allSessions, projectName, onResume, onDelete, onDeleteAll }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const trimmedQuery = query.trim();
  const searchActive = trimmedQuery.length >= 2;
  const searchScope = allSessions?.length ? allSessions : sessions;
  const scopeKey = searchScope.map((session) => session.id).join("\u0000");

  useEffect(() => {
    if (!isOpen || trimmedQuery.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void window.electronAPI.searchSessionMessages(
        trimmedQuery,
        60,
        searchScope.map((session) => session.id),
      )
        .then((result) => { if (!cancelled) setHits(result.hits || []); })
        .catch(() => { if (!cancelled) setHits([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // scopeKey 代替 searchScope：父组件每次渲染都会新建数组。
  }, [isOpen, trimmedQuery, scopeKey]);

  const sessionById = new Map(searchScope.map((session) => [session.id, session]));

  const handleExport = async (session: ProjectSession) => {
    if (exportingId) return;
    setExportingId(session.id);
    try {
      const result = await window.electronAPI.exportSessionMarkdown({
        sessionId: session.id,
        title: session.title || session.preview || "会话",
        projectName,
        agentName: getAgentName(session.agentId),
      });
      if (result.ok) showFloatingToastMessage(`已导出到 ${result.filePath}`);
      else if (!result.canceled) showFloatingToastMessage(result.error || "导出失败");
    } finally {
      setExportingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    try {
      if (confirmDelete.kind === "all") {
        await onDeleteAll();
      } else {
        await onDelete(confirmDelete.sessionId);
      }
      setConfirmDelete(null);
    } catch {
      // The parent reports the persistence error and the confirmation stays open for retry.
    } finally {
      setDeleting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="session-modal-overlay" onClick={onClose}>
      <div className="session-modal" onClick={(e) => e.stopPropagation()}>
        <div className="session-modal-header">
          <div className="session-modal-title-group">
            <span className="session-modal-title">历史会话</span>
            <span className="session-modal-count">{sessions.length}</span>
          </div>
          <div className="session-modal-header-actions">
            {sessions.length > 0 && (
              <button
                type="button"
                className="session-modal-delete-all"
                onClick={() => setConfirmDelete({ kind: "all" })}
              >
                彻底删除全部
              </button>
            )}
            <button onClick={onClose} className="session-modal-close" aria-label="关闭历史会话">×</button>
          </div>
        </div>

        <div className="session-modal-body">
          <div className="session-search">
            <Search size={14} strokeWidth={2} />
            <input
              className="session-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索全部会话内容（至少 2 个字）"
              spellCheck={false}
            />
            {searchActive && (
              <span className="session-search-count">
                {searching ? "搜索中…" : `${hits.length} 条`}
              </span>
            )}
          </div>
          {searchActive ? (
            hits.length === 0 ? (
              <p className="session-empty">{searching ? "正在搜索…" : "没有匹配的消息"}</p>
            ) : (
              <div className="session-search-results">
                {hits.map((hit) => {
                  const session = sessionById.get(hit.sessionId);
                  return (
                    <button
                      key={`${hit.sessionId}:${hit.messageId}`}
                      type="button"
                      className="session-hit"
                      onClick={() => {
                        if (session) onResume(session);
                      }}
                      disabled={!session}
                    >
                      <div className="session-hit-head">
                        <span className="session-hit-session">{session?.title || hit.sessionId}</span>
                        <span className="session-hit-role">{hit.role === "user" ? "用户" : hit.role === "system" ? "系统" : "助手"}</span>
                        <span className="session-hit-time">{hit.timestamp ? formatTime(new Date(hit.timestamp).toISOString()) : ""}</span>
                      </div>
                      <div className="session-hit-snippet">{hit.snippet}</div>
                    </button>
                  );
                })}
              </div>
            )
          ) : sessions.length === 0 ? (
            <p className="session-empty">暂无会话记录</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => {
                // 预览区是单行 ellipsis，悬浮时给出未截断的完整内容。
                const previewText = getSessionPreviewText(session, sessionMessages);
                return (
                  <div key={session.id} className="session-item">
                    <div className="session-item-header">
                      <div className="session-item-meta">
                        <span className="session-time">{formatTime(session.lastActiveAt || session.createdAt)}</span>
                        <span className="session-agent-badge" title={getAgentName(session.agentId)}>
                          {getAgentName(session.agentId)}
                        </span>
                      </div>
                      <div className="session-actions">
                        <button
                          onClick={() => void handleExport(session)}
                          className="session-btn export"
                          disabled={exportingId === session.id}
                        >
                          {exportingId === session.id ? "导出中…" : "导出"}
                        </button>
                        <button
                          onClick={() => onResume(session)}
                          className="session-btn resume"
                        >
                          恢复
                        </button>
                        <button
                          onClick={() => setConfirmDelete({ kind: "session", sessionId: session.id })}
                          className="session-btn delete"
                        >
                          彻底删除
                        </button>
                      </div>
                    </div>
                    <div className="session-preview" title={previewText}>
                      {isForkedSession(session) && (
                        <span
                          className="session-fork-badge"
                          title={`Fork 自 ${session.forkedFrom?.sourceTitle || session.forkContext?.sourceTitle || "原会话"}`}
                        >
                          <GitBranch size={12} strokeWidth={2} />
                        </span>
                      )}
                      <AttachmentPreviewText
                        content={previewText}
                        className="session-preview-text"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {confirmDelete && (
          <div className="session-confirm-overlay" onClick={(e) => e.stopPropagation()}>
            <div className="session-confirm">
              <div className="session-confirm-title">
                {confirmDelete.kind === "all" ? `永久删除全部 ${sessions.length} 个历史会话？` : "永久删除此会话？"}
              </div>
              <div className="session-confirm-desc">会话、消息与草稿快照会从本机删除，删除后无法恢复。</div>
              <div className="session-confirm-actions">
                <button disabled={deleting} onClick={() => setConfirmDelete(null)} className="session-btn cancel">取消</button>
                <button disabled={deleting} onClick={() => void handleConfirmDelete()} className="session-btn delete">
                  {deleting ? "正在删除..." : "彻底删除"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
