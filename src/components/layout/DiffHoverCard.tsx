import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "lucide-react";
import { buildDiffPreviewLines } from "@/lib/diff-hover-preview";

export type DiffHoverFile = {
  file: string;
  additions: number;
  deletions: number;
  patches: string[];
};

type DiffHoverCardProps = {
  file: DiffHoverFile;
  /** 文件行的屏幕坐标；面板仍贴着这一行的高度出现。 */
  anchorRect: DOMRect;
  /** 打开完整文件（预览窗或编辑器）。 */
  onOpenFile?: () => void;
  onClose: () => void;
};

const VIEWPORT_GAP = 12;
const LINE_CLASS: Record<string, string> = {
  header: "chat-diff-header-line",
  add: "chat-diff-add-line",
  del: "chat-diff-del-line",
  context: "",
};

/**
 * 点击 diff 文件行弹出的只读 diff 浮窗：横向按视口铺开并盖过侧边栏，
 * 高度沿用原浮层的 64vh，垂直位置贴着文件行。
 */
export function DiffHoverCard({ file, anchorRect, onOpenFile, onClose }: DiffHoverCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState<number | null>(null);
  const { lines, hiddenCount } = useMemo(
    () => buildDiffPreviewLines(file.patches),
    [file.patches],
  );

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const nextTop = Math.min(
      Math.max(VIEWPORT_GAP, anchorRect.top - 8),
      Math.max(VIEWPORT_GAP, window.innerHeight - rect.height - VIEWPORT_GAP),
    );
    setTop((previous) => (previous === nextTop ? previous : nextTop));
  }, [anchorRect, file.file, lines.length]);

  return createPortal(
    <div
      ref={cardRef}
      className="chat-diff-hover-card"
      role="dialog"
      aria-modal="true"
      aria-label={`${file.file} 的改动`}
      data-diff-hover-card=""
      style={top === null ? { top: 0, visibility: "hidden" } : { top }}
    >
      <div className="chat-diff-hover-card-header">
        <span className="chat-diff-hover-card-path" title={file.file}>{file.file}</span>
        <span className="chat-diff-hover-card-stats">
          <span className="chat-diff-add">+{file.additions}</span>
          <span className="chat-diff-del">-{file.deletions}</span>
        </span>
        {onOpenFile && (
          <button
            type="button"
            className="chat-diff-hover-card-open"
            onClick={onOpenFile}
            title="打开文件查看完整内容"
          >
            <FileText size={13} strokeWidth={2} />
            <span>打开文件</span>
          </button>
        )}
        <button
          type="button"
          className="chat-diff-hover-card-close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>
      <pre className="chat-diff-hover-card-content">
        {lines.map((line, index) => (
          <span
            key={`${file.file}-${index}`}
            className={`chat-diff-line ${LINE_CLASS[line.kind] || ""}`.trim()}
          >
            {line.text || " "}
          </span>
        ))}
      </pre>
      {hiddenCount > 0 && (
        <div className="chat-diff-hover-card-more">
          仅预览前 {lines.length} 行，还有 {hiddenCount} 行；点「打开文件」查看完整改动
        </div>
      )}
    </div>,
    document.body,
  );
}
