import { useState } from "react";
import type { ProjectSession } from "@/stores/project-store";
import type { ChatMessage } from "@/stores/chat-store";
import "./SessionHistory.css";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sessions: ProjectSession[];
  sessionMessages: Record<string, ChatMessage[]>;
  onResume: (session: ProjectSession) => void;
  onDelete: (sessionId: string) => void;
}

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

export function SessionHistoryModal({ isOpen, onClose, sessions, sessionMessages, onResume, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (!isOpen) return null;

  return (
    <div className="session-modal-overlay" onClick={onClose}>
      <div className="session-modal" onClick={(e) => e.stopPropagation()}>
        <div className="session-modal-header">
          <span className="session-modal-title">历史会话</span>
          <button onClick={onClose} className="session-modal-close">×</button>
        </div>

        <div className="session-modal-body">
          {sessions.length === 0 ? (
            <p className="session-empty">暂无会话记录</p>
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <div key={session.id} className="session-item">
                  <div className="session-item-header">
                    <span className="session-time">{formatTime(session.createdAt)}</span>
                    <div className="session-actions">
                      <button
                        onClick={() => onResume(session)}
                        className="session-btn resume"
                      >
                        恢复
                      </button>
                      <button
                        onClick={() => setConfirmDelete(session.id)}
                        className="session-btn delete"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <div className="session-preview">
                    {(() => {
                      const msgs = sessionMessages[session.id];
                      const firstUserMsg = msgs?.find((m) => m.role === "user");
                      return firstUserMsg
                        ? firstUserMsg.content.length > 50
                          ? firstUserMsg.content.substring(0, 50) + "..."
                          : firstUserMsg.content
                        : session.title;
                    })()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {confirmDelete && (
          <div className="session-confirm-overlay" onClick={(e) => e.stopPropagation()}>
            <div className="session-confirm">
              <div className="session-confirm-title">确定删除此会话？</div>
              <div className="session-confirm-desc">删除后无法恢复。</div>
              <div className="session-confirm-actions">
                <button onClick={() => setConfirmDelete(null)} className="session-btn cancel">取消</button>
                <button onClick={() => { onDelete(confirmDelete); setConfirmDelete(null); }} className="session-btn delete">删除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
