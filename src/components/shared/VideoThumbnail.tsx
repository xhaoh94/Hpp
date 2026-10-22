import { Film } from "lucide-react";
import { useLocalMediaBaseUrl } from "@/hooks/useLocalMediaBaseUrl";
import { toLocalMediaUrl } from "@/lib/media-preview";

/**
 * 视频缩略图：用 <video> 的首帧当封面（preload=metadata + #t=0.1），
 * 让视频在输入框/消息里和图片一样以"画面"呈现，而不是文件名 chip。
 */
export function VideoThumbnail({
  path,
  name,
  className = "",
}: {
  path: string;
  name: string;
  className?: string;
}) {
  const baseUrl = useLocalMediaBaseUrl();
  const src = toLocalMediaUrl(path, baseUrl);
  if (!src) {
    return <Film className={`composer-entity-icon video ${className}`} size={14} />;
  }
  return (
    <span className={`composer-video-thumb ${className}`} aria-hidden="true">
      <video
        src={`${src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        title={name}
      />
      <span className="composer-video-thumb-play">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path d="M1 0.5 7 4 1 7.5Z" />
        </svg>
      </span>
    </span>
  );
}
