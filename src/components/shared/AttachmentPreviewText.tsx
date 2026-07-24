import { FileText, Folder } from "lucide-react";
import "./AttachmentPreviewText.css";

interface Props {
  content: string;
  maxLength?: number;
  className?: string;
}

/** Renders the compact attachment tokens used in message/session previews. */
export function AttachmentPreviewText({ content, maxLength, className = "" }: Props) {
  const preview = maxLength && content.length > maxLength
    ? `${content.substring(0, maxLength)}...`
    : content;
  const parts = preview.split(/(\[(?:file|folder):[^\]]+\])/g);

  return (
    <span className={`attachment-preview-text ${className}`.trim()}>
      {parts.map((part, index) => {
        const match = part.match(/^\[(file|folder):\s*([^\]]+)\]$/);
        if (!match) return <span key={index}>{part}</span>;
        const kind = match[1];
        return (
          <span className={`attachment-preview-token ${kind}`} key={index} title={match[2]}>
            {kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}
            <span>{match[2]}</span>
          </span>
        );
      })}
    </span>
  );
}
