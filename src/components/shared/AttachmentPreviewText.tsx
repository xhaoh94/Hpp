import { FileText, Folder } from "lucide-react";
import "./AttachmentPreviewText.css";

interface Props {
  content: string;
  maxLength?: number;
  className?: string;
}

/** Renders the compact attachment tokens used in message/session previews. */
export function AttachmentPreviewText({ content, maxLength, className = "" }: Props) {
  let preview = content;
  if (maxLength && content.length > maxLength) {
    let cutoff = maxLength;
    // Never cut through an attachment token. Extend the preview to its closing ]
    // so it can still be rendered as a chip.
    const token = /\[(?:file|folder):[^\]]+\]/g;
    let match: RegExpExecArray | null;
    while ((match = token.exec(content))) {
      const end = match.index + match[0].length;
      if (match.index < cutoff && end > cutoff) cutoff = end;
      if (match.index >= cutoff) break;
    }
    preview = `${content.substring(0, cutoff)}...`;
  }
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
