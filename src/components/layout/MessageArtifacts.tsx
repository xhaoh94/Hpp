import { memo, useEffect, useMemo, useState } from "react";
import { ChevronDown, FileText, Image as ImageIcon, FileCode } from "lucide-react";
import { collectMessageArtifacts, type MessageArtifact } from "@/lib/message-artifacts";
import type { ChatMessage } from "@/stores/chat-store";
import "./MessageArtifacts.css";

interface MessageArtifactsProps {
  message: ChatMessage;
  /** 打开产物：图片直接看预览，html 走渲染效果，其余按文件预览。 */
  onOpenFile: (path: string, options?: { preview?: boolean }) => void;
  /** 已由 diff 面板展示过的文件；这里跳过，避免同一文件重复列出。 */
  excludePaths?: string[];
  /** 当前项目根目录：用来把工作区里的 tmp/.tmp 草稿排除掉。 */
  workspacePath?: string;
}

const KIND_ICON = {
  image: ImageIcon,
  document: FileCode,
  file: FileText,
} as const;

const MAX_THUMBNAILS = 4;

function ArtifactThumbnail({ artifact }: { artifact: MessageArtifact }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.readFileDataUrl(artifact.path).then((result) => {
      if (cancelled || !result.success) return;
      setSrc(result.dataUrl || "");
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artifact.path]);

  if (!src) return <span className="chat-artifact-thumb-fallback"><ImageIcon size={14} /></span>;
  return <img className="chat-artifact-thumb" src={src} alt={artifact.name} loading="lazy" />;
}

/**
 * 消息底部的产物清单：默认只显示「产物 N」一行，点开列出这次写出的文件。
 * 图片直接给缩略图，避免用户还要自己去翻处理过程找路径。
 */
export const MessageArtifacts = memo(function MessageArtifacts({
  message,
  onOpenFile,
  excludePaths,
  workspacePath,
}: MessageArtifactsProps) {
  const artifacts = useMemo(
    () => collectMessageArtifacts(message, { excludePaths, workspacePath }),
    [message, excludePaths, workspacePath],
  );
  const [expanded, setExpanded] = useState(false);
  if (artifacts.length === 0) return null;

  const images = artifacts.filter((artifact) => artifact.kind === "image");
  const collapsedThumbnails = images.slice(0, MAX_THUMBNAILS);

  return (
    <div className={`chat-artifacts${expanded ? " expanded" : ""}`} data-artifacts="">
      <button
        type="button"
        className={`chat-artifacts-toggle${expanded ? " expanded" : ""}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="chat-artifacts-label">产物 {artifacts.length}</span>
        {!expanded && collapsedThumbnails.length > 0 && (
          <span className="chat-artifacts-thumbs" aria-hidden="true">
            {collapsedThumbnails.map((artifact) => (
              <ArtifactThumbnail key={artifact.path} artifact={artifact} />
            ))}
            {images.length > collapsedThumbnails.length && (
              <span className="chat-artifacts-thumb-more">+{images.length - collapsedThumbnails.length}</span>
            )}
          </span>
        )}
        <ChevronDown size={13} className="chat-artifacts-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="chat-artifacts-list">
          {artifacts.map((artifact) => {
            const Icon = KIND_ICON[artifact.kind] || FileText;
            return (
              <button
                key={artifact.path}
                type="button"
                className="chat-artifact-row"
                onClick={() => onOpenFile(artifact.path, { preview: true })}
                title={artifact.path}
              >
                {artifact.kind === "image" ? (
                  <ArtifactThumbnail artifact={artifact} />
                ) : (
                  <span className="chat-artifact-icon"><Icon size={13} strokeWidth={1.9} /></span>
                )}
                <span className="chat-artifact-name">{artifact.name}</span>
                <span className="chat-artifact-path">{artifact.path}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
