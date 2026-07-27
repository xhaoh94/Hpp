import { ShieldAlert } from "lucide-react";

export function ConfirmationPanel({
  title,
  description,
  onConfirm,
  onReject,
}: {
  title?: string;
  description?: string;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <div className="chat-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="chat-confirmation-title">
      <div className="chat-confirmation-icon"><ShieldAlert size={18} /></div>
      <div className="chat-confirmation-content">
        <strong id="chat-confirmation-title">{title || "Agent 请求权限"}</strong>
        {description && <pre>{description}</pre>}
      </div>
      <div className="chat-confirmation-actions">
        <button type="button" className="secondary" onClick={onReject}>拒绝</button>
        <button type="button" className="primary" onClick={onConfirm}>允许</button>
      </div>
    </div>
  );
}
