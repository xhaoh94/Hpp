import type { ComposerDocument } from "@shared/composer-document";
import { ComposerEntityIcon } from "./ComposerEntityIcon";
import { openVideoPreview } from "@/lib/media-preview";
import { VideoThumbnail } from "./VideoThumbnail";

export function ComposerMessageFlow({
  document,
  onOpenImage,
  onOpenVideo,
}: {
  document: ComposerDocument;
  onOpenImage?: (src: string) => void;
  onOpenVideo?: (path: string) => void;
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
        if (node.type === "video") {
          // 视频在消息气泡里是独立的媒体块（chat-videos），不在正文流里重复一行。
          return null;
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
