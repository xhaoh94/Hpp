import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText } from "lucide-react";
import { buildDiffPreviewLines } from "@/lib/diff-hover-preview";

export type DiffHoverFile = {
  file: string;
  additions: number;
  deletions: number;
  patches: string[];
};

type DiffHoverCardProps = {
  file: DiffHoverFile;
  /** 文件行的屏幕坐标；卡片贴着这一行显示，避免用户视线来回跳。 */
  anchorRect: DOMRect;
  /** 打开完整文件（预览窗或编辑器）。 */
  onOpenFile?: () => void;
};

const VIEWPORT_GAP = 12;
const ANCHOR_GAP = 14;
const LINE_CLASS: Record<string, string> = {
  header: "chat-diff-header-line",
  add: "chat-diff-add-line",
  del: "chat-diff-del-line",
  context: "",
};

/**
 * 聊天面板 diff 卡片的就地面板：点击文件行弹出的只读 diff 浮层。
 * 用 portal 挂到 body，避免被消息虚拟列表的 overflow 裁掉；位置按文件行
 * 右侧优先、放不下再翻到左侧，并始终夹在视口内。
 */
export function DiffHoverCard({ file, anchorRect, onOpenFile }: DiffHoverCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const { lines, hiddenCount } = useMemo(
    () => buildDiffPreviewLines(file.patches),
    [file.patches],
  );

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    // 卡片宽度是视口百分比（CSS clamp），测量出来的 rect 就是当前宽度；
    // 窗口 resize 时 DiffBlock 会直接关掉浮层，重新 hover 会按新尺寸重算。
    const rect = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fitsRight = anchorRect.right + ANCHOR_GAP + rect.width <= viewportWidth - VIEWPORT_GAP;
    const fitsLeft = anchorRect.left - ANCHOR_GAP - rect.width >= VIEWPORT_GAP;
    let left: number;
    let top: number;
    if (fitsRight) {
      left = anchorRect.right + ANCHOR_GAP;
      top = anchorRect.top - 8;
    } else if (fitsLeft) {
      left = anchorRect.left - ANCHOR_GAP - rect.width;
      top = anchorRect.top - 8;
    } else {
      // 左右都被挤满（窄窗口）：贴到文件行下方，避免浮层盖住正在悬停的行。
      left = Math.max(
        VIEWPORT_GAP,
        Math.min(anchorRect.left, viewportWidth - rect.width - VIEWPORT_GAP),
      );
      top = anchorRect.bottom + 8;
    }
    left = Math.max(
      VIEWPORT_GAP,
      Math.min(left, viewportWidth - rect.width - VIEWPORT_GAP),
    );
    top = Math.min(
      Math.max(VIEWPORT_GAP, top),
      Math.max(VIEWPORT_GAP, viewportHeight - rect.height - VIEWPORT_GAP),
    );
    setPosition((previous) => (
      previous && previous.left === left && previous.top === top ? previous : { left, top }
    ));
  }, [anchorRect, file.file, lines.length]);

  return createPortal(
    <div
      ref={cardRef}
      className="chat-diff-hover-card"
      role="tooltip"
      data-diff-hover-card=""
      style={position
        ? { left: position.left, top: position.top }
        : { left: 0, top: 0, visibility: "hidden" }}
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
