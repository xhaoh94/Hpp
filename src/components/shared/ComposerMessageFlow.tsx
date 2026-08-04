import type { ComposerDocument } from "@shared/composer-document";
import { ComposerEntityIcon } from "./ComposerEntityIcon";

export function ComposerMessageFlow({
  document,
  onOpenImage,
}: {
  document: ComposerDocument;
  onOpenImage?: (src: string) => void;
}) {
  return (
    <span className="composer-message-flow">
      {document.nodes.map((node) => {
        if (node.type === "text") {
          return <span key={node.id} className="composer-message-text">{node.text}</span>;
        }
        if (node.type === "image") {
          return (
            <button
              type="button"
              className="composer-message-image"
              key={node.id}
              title={node.name}
              onClick={() => onOpenImage?.(node.src)}
            >
              <img src={node.src} alt={node.name} />
              <span className="composer-message-image-label">Image</span>
            </button>
          );
        }
        const label = node.type === "session"
          ? `引用会话: ${node.reference.sourceTitle}`
          : node.type === "snippet"
            ? `${node.fileName}:${node.startLine}-${node.endLine}`
            : node.name;
        return <span key={node.id} className={`composer-message-entity ${node.type}`}><ComposerEntityIcon node={node} /><span>{label}</span></span>;
      })}
    </span>
  );
}
