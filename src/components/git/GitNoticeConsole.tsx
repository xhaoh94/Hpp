import { AlertTriangle, ChevronDown, Eraser, X } from "lucide-react";
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
  /** error = 红色调（操作失败），默认 warning 黄色。 */
  tone?: "warning" | "error";
  actions?: GitNoticeAction[];
  onClose: () => void;
}

interface Props {
  notices: GitNotice[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 清空全部打印（控制台语义：只清显示，不影响 git 状态之外的业务）。 */
  onClearAll: () => void;
}

/**
 * 控制台式浮动通知面板：报错不打断布局，收起后可从右下角按钮重新打开，
 * 「清除」一键清空打印。
 */
export function GitNoticeConsole({ notices, open, onOpenChange, onClearAll }: Props) {
  // 没有打印就整个不渲染；下一条通知到来时由调用方自动展开面板。
  if (notices.length === 0) return null;
  if (!open) {
    return createPortal(
      <button
        type="button"
        className="git-notice-launcher"
        onClick={() => onOpenChange(true)}
        title={`打开通知（${notices.length}）`}
      >
        <AlertTriangle size={15} />
        <span className="git-notice-launcher-badge">{notices.length}</span>
      </button>,
      document.body,
    );
  }

  return createPortal(
    <div className="git-notice-console-stack">
      <div className="git-notice-console-head">
        <strong>通知{notices.length > 0 ? ` · ${notices.length}` : ""}</strong>
        <button
          type="button"
          className="git-notice-console-tool"
          onClick={onClearAll}
          disabled={notices.length === 0}
          title="清空全部打印"
        >
          <Eraser size={13} /> 清除
        </button>
        <button
          type="button"
          className="git-notice-console-tool"
          onClick={() => onOpenChange(false)}
          title="收起（可从右下角重新打开）"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {notices.map((notice) => (
        <div
          className={`git-floating-notice${notice.tone === "error" ? " error" : ""}`}
          key={notice.id}
          role="alertdialog"
          aria-label={notice.title}
        >
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
