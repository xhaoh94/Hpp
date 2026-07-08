import { useState, useRef, useEffect, useMemo, useCallback, Component, type ReactNode } from "react";
import { useChatStore } from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import "./FilePreview.css";

class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface FilePreviewProps {
  filePath: string | null;
  onClose: () => void;
}

const MAX_RENDER_LINES = 1000;
const MAX_MARKDOWN_CHARS = 500000;

export function FilePreview({ filePath, onClose }: FilePreviewProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<boolean | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selection: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const { addPendingFile } = useChatStore();

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleClose = useCallback(() => {
    setContextMenu(null);
    onCloseRef.current();
  }, []);

  const isMarkdown = useMemo(() => {
    if (!filePath) return false;
    return /\.mdx?$/i.test(filePath);
  }, [filePath]);

  useEffect(() => {
    setPreviewMode(isMarkdown ? true : null);
  }, [isMarkdown]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    const loadContent = async () => {
      setLoading(true);
      setError(null);
      setContent("");
      try {
        const result = await window.electronAPI.readFile(filePath);
        if (cancelled) return;
        if (result.success) {
          setContent(result.content || "");
        } else {
          setError(result.error || "无法读取文件");
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "无法读取文件");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadContent();
    return () => { cancelled = true; };
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [filePath, handleClose]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".fp-context-menu")) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClick, true);
    return () => document.removeEventListener("mousedown", handleClick, true);
  }, [contextMenu]);

  const fileName = useMemo(() => filePath?.split(/[/\\]/).pop() || filePath || "", [filePath]);
  const showMarkdownPreview = previewMode === true && isMarkdown;

  const contentLines = useMemo(() => content.split("\n"), [content]);
  const totalLines = contentLines.length;
  const shouldLimit = totalLines > MAX_RENDER_LINES && !showMarkdownPreview;
  const displayContent = useMemo(() => {
    if (loading) return "";
    if (shouldLimit) return contentLines.slice(0, MAX_RENDER_LINES).join("\n");
    return content;
  }, [content, contentLines, shouldLimit, loading]);

  const markdownContent = useMemo(() => {
    if (!showMarkdownPreview) return content;
    if (content.length > MAX_MARKDOWN_CHARS) {
      return content.slice(0, MAX_MARKDOWN_CHARS) + "\n\n> ... 内容过长，已截断显示";
    }
    return content;
  }, [content, showMarkdownPreview]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
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
    },
    []
  );

  const handleSendToChat = useCallback(() => {
    if (!contextMenu || !filePath) return;
    addPendingFile({
      id: crypto.randomUUID(),
      fileName,
      filePath,
      startLine: contextMenu.startLine,
      endLine: contextMenu.endLine,
    });
    setContextMenu(null);
  }, [contextMenu, filePath, fileName, addPendingFile]);

  if (!filePath) return null;

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
        {isMarkdown && (
          <div className="fp-toolbar">
            <button
              className={`fp-toolbar-btn ${previewMode === true ? 'active' : ''}`}
              onClick={() => setPreviewMode(true)}
            >
              预览
            </button>
            <button
              className={`fp-toolbar-btn ${previewMode === false ? 'active' : ''}`}
              onClick={() => setPreviewMode(false)}
            >
              源码
            </button>
          </div>
        )}
        <div className="fp-content" onContextMenu={handleContextMenu}>
          {loading ? (
            <div className="fp-status">加载中...</div>
          ) : error ? (
            <div className="fp-status fp-error">{error}</div>
          ) : showMarkdownPreview ? (
            <div className="fp-markdown-preview">
              <ErrorBoundary fallback={<div className="fp-status">Markdown 渲染失败，请切换到源码模式</div>}>
                <MarkdownRenderer content={markdownContent} />
              </ErrorBoundary>
            </div>
          ) : (
            <pre ref={contentRef} className="fp-text" data-file-path={filePath}>
              {displayContent.split('\n').map((line, i) => (
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
