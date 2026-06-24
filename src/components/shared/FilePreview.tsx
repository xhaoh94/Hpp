import { useState, useRef, useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";
import "./FilePreview.css";

interface FilePreviewProps {
  filePath: string | null;
  onClose: () => void;
}

export function FilePreview({ filePath, onClose }: FilePreviewProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selection: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const { addPendingFile } = useChatStore();

  useEffect(() => {
    if (!filePath) return;
    const loadContent = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.electronAPI.readFile(filePath);
        if (result.success) {
          setContent(result.content || "");
        } else {
          setError(result.error || "无法读取文件");
        }
      } catch (err: any) {
        setError(err.message || "无法读取文件");
      } finally {
        setLoading(false);
      }
    };
    loadContent();
  }, [filePath]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".fp-context-menu")) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClose, true);
    return () => document.removeEventListener("mousedown", handleClose, true);
  }, [contextMenu]);

  if (!filePath) return null;

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  const handleContextMenu = (e: React.MouseEvent) => {
    setContextMenu(null);
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const selectedText = selection.toString();
    if (!selectedText.trim()) return;

    const contentEl = contentRef.current;
    if (!contentEl) return;

    let startLine = 1;
    let endLine = 1;
    try {
      const range = selection.getRangeAt(0);
      let startNode: Node | null = range.startContainer;
      while (startNode && startNode !== contentEl) {
        if (startNode instanceof HTMLElement && startNode.dataset.line) {
          startLine = parseInt(startNode.dataset.line, 10);
          break;
        }
        startNode = startNode.parentNode;
      }
      let endNode: Node | null = range.endContainer;
      while (endNode && endNode !== contentEl) {
        if (endNode instanceof HTMLElement && endNode.dataset.line) {
          endLine = parseInt(endNode.dataset.line, 10);
          break;
        }
        endNode = endNode.parentNode;
      }
      if (endLine < startLine) endLine = startLine;
    } catch {}

    e.preventDefault();
    setTimeout(() => {
      setContextMenu({ x: e.clientX, y: e.clientY, selection: selectedText, startLine, endLine });
    }, 10);
  };

  const handleSendToChat = () => {
    if (!contextMenu || !filePath) return;
    addPendingFile({
      id: crypto.randomUUID(),
      fileName,
      filePath,
      startLine: contextMenu.startLine,
      endLine: contextMenu.endLine,
    });
    setContextMenu(null);
  };

  const handleClose = () => {
    setContextMenu(null);
    onClose();
  };

  return (
    <div className="fp-overlay" onClick={handleClose}>
      <div className="fp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fp-header">
          <div className="fp-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M6 2H14L20 8V20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20V4C4 2.89543 4.89543 2 6 2Z" stroke="currentColor" strokeWidth="1.5" />
              <path d="M14 2V8H20" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>{fileName}</span>
          </div>
          <button className="fp-close" onClick={handleClose}>×</button>
        </div>
        <div className="fp-content" onContextMenu={handleContextMenu}>
          {loading ? (
            <div className="fp-status">加载中...</div>
          ) : error ? (
            <div className="fp-status fp-error">{error}</div>
          ) : (
            <pre ref={contentRef} className="fp-text" data-file-path={filePath}>
              {content.split("\n").map((line, i) => (
                <div key={i} className="fp-line" data-line={i + 1}>
                  <span className="fp-line-number" data-line={i + 1}>{i + 1}</span>
                  <span className="fp-line-content" data-line={i + 1}>{line}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
        <div className="fp-footer">
          <span>选择内容后右键可发送到聊天</span>
        </div>
      </div>

      {contextMenu && (
        <div className="fp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="fp-cm-header">发送到聊天</div>
          <div className="fp-cm-info">第 {contextMenu.startLine} - {contextMenu.endLine} 行</div>
          <button className="fp-cm-btn" onClick={handleSendToChat}>
            发送 [{fileName}:{contextMenu.startLine}-{contextMenu.endLine}]
          </button>
        </div>
      )}
    </div>
  );
}
