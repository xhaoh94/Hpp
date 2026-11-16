import { AlertTriangle, X } from "lucide-react";
import { createPortal } from "react-dom";

export interface GitNoticeAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface GitNotice {
  id: string;
  title: string;
  message: string;
  actions?: GitNoticeAction[];
  onClose: () => void;
}

interface Props {
  notices: GitNotice[];
}

/** 独立浮动通知窗：挂到 body 右上角，不挤占工作台布局，手动关闭。 */
export function GitFloatingNotice({ notices }: Props) {
  if (notices.length === 0) return null;
  return createPortal(
    <div className="git-floating-notice-stack">
      {notices.map((notice) => (
        <div className="git-floating-notice" key={notice.id} role="alertdialog" aria-label={notice.title}>
          <div className="git-floating-notice-head">
            <AlertTriangle size={14} />
            <strong>{notice.title}</strong>
            <button
              type="button"
              className="git-floating-notice-close"
              onClick={notice.onClose}
              aria-label="关闭通知"
            >
              <X size={13} />
            </button>
          </div>
          <div className="git-floating-notice-body">{notice.message}</div>
          {notice.actions && notice.actions.length > 0 && (
            <div className="git-floating-notice-actions">
              {notice.actions.map((action) => (
                <button
                  type="button"
                  key={action.label}
                  className={action.danger ? "danger" : undefined}
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
