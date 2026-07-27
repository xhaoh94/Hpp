import { ShieldAlert } from "lucide-react";
import type { AskQuestionOption, AskQuestionPayload } from "./QuestionnairePanel";

export function PermissionChoicePanel({
  title,
  description,
  question,
  onSelect,
}: {
  title?: string;
  description?: string;
  question?: AskQuestionPayload;
  onSelect: (option: AskQuestionOption) => void;
}) {
  const detail = description || question?.question;
  return (
    <div className="chat-confirmation chat-permission-choice" role="alertdialog" aria-modal="false">
      <div className="chat-confirmation-icon"><ShieldAlert size={18} /></div>
      <div className="chat-confirmation-content">
        <strong>{title || "Agent 请求权限"}</strong>
        {detail && <pre>{detail}</pre>}
      </div>
      <div className="chat-permission-choice-actions">
        {(question?.options || []).map((option) => {
          const value = String(option.value || option.label).toLowerCase();
          const rejecting = value === "reject" || value === "deny" || value === "cancel";
          return (
            <button
              type="button"
              className={rejecting ? "secondary" : "primary"}
              key={`${option.value || ""}:${option.label}`}
              onClick={() => onSelect(option)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
