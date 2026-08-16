import { useState, useRef, useEffect, useMemo, useCallback, Component, type ReactNode } from "react";
import { useChatStore } from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import {
  buildDisplayTokens,
  buildHighlightedLines,
  findTextMatches,
  getFilePreviewLanguage,
  getNextSearchMatchIndex,
  getRenderWindow,
  parseGoToLine,
  type IndexedSearchMatch,
} from "@/lib/file-preview-code";
import "./FilePreview.css";
import { requestComposerInsert } from "@/lib/composer-insert-event";

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
const IMAGE_FILE_PATTERN = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

function getPathDirectory(filePath: string) {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return index >= 0 ? filePath.slice(0, index) : "";
}

function decodeHrefPath(href: string) {
  const pathWithoutHash = href.split("#")[0] || "";
  const pathWithoutQuery = pathWithoutHash.split("?")[0] || "";
  try {
    return decodeURIComponent(pathWithoutQuery);
  } catch {
    return pathWithoutQuery;
  }
}

function resolveMarkdownLinkPath(baseFilePath: string, href: string) {
  const targetPath = decodeHrefPath(href).trim();
  if (!targetPath || targetPath.startsWith("#")) return null;
  if (targetPath.startsWith("//")) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(targetPath)) return null;
  if (targetPath.startsWith("/") || targetPath.startsWith("\\")) return null;
  if (!/\.mdx?$/i.test(targetPath)) return null;

  const separator = baseFilePath.includes("\\") ? "\\" : "/";
  const baseDirectory = getPathDirectory(baseFilePath);
  const rootPrefix = baseDirectory.startsWith("/") ? "/" : "";
  const baseParts = baseDirectory.split(/[\\/]+/).filter(Boolean);
  const minParts = /^[a-zA-Z]:$/.test(baseParts[0] || "") ? 1 : 0;
  const targetParts = targetPath.split(/[\\/]+/);
  const nextParts = [...baseParts];

  for (const part of targetParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (nextParts.length > minParts) nextParts.pop();
      continue;
    }
    nextParts.push(part);
  }

  return `${rootPrefix}${nextParts.join(separator)}`;
}

export function FilePreview({ filePath, onClose }: FilePreviewProps) {
  const [content, setContent] = useState("");
  const [imageSrc, setImageSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [previewMode, setPreviewMode] = useState<boolean | null>(null);
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");
  const [goToLineError, setGoToLineError] = useState(false);
  const [windowAnchorLine, setWindowAnchorLine] = useState(1);
  const [jumpTargetLine, setJumpTargetLine] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selection: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const { addPendingFile } = useChatStore();

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const activeFilePath = previewHistory[previewHistory.length - 1] || filePath;

  const handleClose = useCallback(() => {
    setContextMenu(null);
    if (previewHistory.length > 0) {
      setPreviewHistory((current) => current.slice(0, -1));
      return;
    }
    onCloseRef.current();
  }, [previewHistory.length]);

  const isMarkdown = useMemo(() => {
    if (!activeFilePath) return false;
    return /\.mdx?$/i.test(activeFilePath);
  }, [activeFilePath]);

  const isImage = useMemo(() => {
    if (!activeFilePath) return false;
    return IMAGE_FILE_PATTERN.test(activeFilePath);
  }, [activeFilePath]);

  useEffect(() => {
    setPreviewMode(isMarkdown ? true : null);
  }, [isMarkdown]);

  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchMatchCase(false);
    setSearchWholeWord(false);
    setActiveMatchIndex(-1);
    setGoToLineOpen(false);
    setGoToLineValue("");
    setGoToLineError(false);
    setWindowAnchorLine(1);
    setJumpTargetLine(null);
  }, [activeFilePath]);

  useEffect(() => {
    setPreviewHistory([]);
  }, [filePath]);

  useEffect(() => {
    if (!activeFilePath) return;
    let cancelled = false;
    const loadContent = async () => {
      setLoading(true);
      setError(null);
      setContent("");
      setImageSrc("");
      setIsBinary(false);
      try {
        if (isImage) {
          const result = await window.electronAPI.readFileDataUrl(activeFilePath);
          if (cancelled) return;
          if (result.success) {
            setImageSrc(result.dataUrl || "");
          } else {
            setError(result.error || "无法读取文件");
          }
        } else {
          const result = await window.electronAPI.readFile(activeFilePath);
          if (cancelled) return;
          if (result.success) {
            if (result.binary) {
              setIsBinary(true);
            } else {
              setContent(result.content || "");
            }
          } else {
            setError(result.error || "无法读取文件");
          }
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
  }, [activeFilePath, isImage]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".fp-context-menu")) return;
      setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClick, true);
    return () => document.removeEventListener("mousedown", handleClick, true);
  }, [contextMenu]);

  const fileName = useMemo(
    () => activeFilePath?.split(/[/\\]/).pop() || activeFilePath || "",
    [activeFilePath]
  );
  const showMarkdownPreview = previewMode === true && isMarkdown;

  const contentLines = useMemo(() => content.split("\n"), [content]);
  const totalLines = contentLines.length;
  const previewLanguage = useMemo(
    () => activeFilePath ? getFilePreviewLanguage(activeFilePath) : null,
    [activeFilePath],
  );
  const highlightedLines = useMemo(
    () => buildHighlightedLines(content, previewLanguage),
    [content, previewLanguage],
  );
  const searchMatches = useMemo(
    () => findTextMatches(contentLines, searchQuery, {
      matchCase: searchMatchCase,
      wholeWord: searchWholeWord,
    }),
    [contentLines, searchMatchCase, searchQuery, searchWholeWord],
  );
  const searchMatchesByLine = useMemo(() => {
    const matchesByLine = new Map<number, IndexedSearchMatch[]>();
    searchMatches.forEach((match, matchIndex) => {
      const lineMatches = matchesByLine.get(match.lineNumber) || [];
      lineMatches.push({ ...match, matchIndex });
      matchesByLine.set(match.lineNumber, lineMatches);
    });
    return matchesByLine;
  }, [searchMatches]);
  const renderWindow = useMemo(
    () => getRenderWindow(totalLines, windowAnchorLine, MAX_RENDER_LINES),
    [totalLines, windowAnchorLine],
  );
  const visibleLineIndexes = useMemo(
    () => Array.from(
      { length: Math.max(0, renderWindow.endIndex - renderWindow.startIndex) },
      (_, index) => renderWindow.startIndex + index,
    ),
    [renderWindow.endIndex, renderWindow.startIndex],
  );

  const markdownContent = useMemo(() => {
    if (!showMarkdownPreview) return content;
    if (content.length > MAX_MARKDOWN_CHARS) {
      return content.slice(0, MAX_MARKDOWN_CHARS) + "\n\n> ... 内容过长，已截断显示";
    }
    return content;
  }, [content, showMarkdownPreview]);

  useEffect(() => {
    const firstMatch = searchMatches[0];
    setActiveMatchIndex(firstMatch ? 0 : -1);
    if (firstMatch) {
      setWindowAnchorLine(firstMatch.lineNumber);
      setJumpTargetLine(null);
    }
  }, [searchMatches]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!goToLineOpen) return;
    const frame = requestAnimationFrame(() => goToLineInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [goToLineOpen]);

  useEffect(() => {
    if (showMarkdownPreview || isImage || loading) return;
    const frame = requestAnimationFrame(() => {
      const currentMatch = searchOpen
        ? contentRef.current?.querySelector(".fp-search-match-current")
        : null;
      const targetLine = searchOpen
        ? searchMatches[activeMatchIndex]?.lineNumber
        : jumpTargetLine;
      const target = currentMatch
        || (targetLine ? contentRef.current?.querySelector(`[data-line="${targetLine}"]`) : null);
      target?.scrollIntoView({ block: "center", inline: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    activeMatchIndex,
    isImage,
    jumpTargetLine,
    loading,
    renderWindow.startIndex,
    searchMatches,
    searchOpen,
    showMarkdownPreview,
  ]);

  const openSearch = useCallback(() => {
    if (isImage) return;
    if (isMarkdown) setPreviewMode(false);
    setGoToLineOpen(false);
    setGoToLineError(false);
    setSearchOpen(true);
  }, [isImage, isMarkdown]);

  const openGoToLine = useCallback(() => {
    if (isImage) return;
    if (isMarkdown) setPreviewMode(false);
    setSearchOpen(false);
    setGoToLineValue("");
    setGoToLineError(false);
    setGoToLineOpen(true);
  }, [isImage, isMarkdown]);

  const navigateSearch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const nextIndex = getNextSearchMatchIndex(activeMatchIndex, searchMatches.length, direction);
    setActiveMatchIndex(nextIndex);
    setWindowAnchorLine(searchMatches[nextIndex].lineNumber);
    setJumpTargetLine(null);
  }, [activeMatchIndex, searchMatches]);

  const submitGoToLine = useCallback(() => {
    const lineNumber = parseGoToLine(goToLineValue, totalLines);
    if (lineNumber === null) {
      setGoToLineError(true);
      return;
    }
    setWindowAnchorLine(lineNumber);
    setJumpTargetLine(lineNumber);
    setGoToLineError(false);
    setGoToLineOpen(false);
  }, [goToLineValue, totalLines]);

  useEffect(() => {
    if (!activeFilePath) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifierPressed = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (searchOpen && event.altKey && !event.ctrlKey && !event.metaKey && key === "c") {
        event.preventDefault();
        setSearchMatchCase((current) => !current);
        return;
      }
      if (searchOpen && event.altKey && !event.ctrlKey && !event.metaKey && key === "w") {
        event.preventDefault();
        setSearchWholeWord((current) => !current);
        return;
      }
      if (!isImage && modifierPressed && key === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (!isImage && modifierPressed && key === "g") {
        event.preventDefault();
        openGoToLine();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (searchOpen) {
        setSearchOpen(false);
        return;
      }
      if (goToLineOpen) {
        setGoToLineOpen(false);
        setGoToLineError(false);
        return;
      }
      handleClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    activeFilePath,
    goToLineOpen,
    handleClose,
    isImage,
    openGoToLine,
    openSearch,
    searchOpen,
  ]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isImage) return;
      setContextMenu(null);

      const contentEl = contentRef.current;
      if (!contentEl) return;

      // 无选中文本时，定位右键点击所在的代码行（点行号不触发）
      const clickedLine = (() => {
        let node: HTMLElement | null = (e.target as HTMLElement).closest(".fp-line-content");
        while (node && node !== contentEl) {
          if (node.dataset.line) return parseInt(node.dataset.line, 10);
          node = node.parentElement;
        }
        return null;
      })();

      const selection = window.getSelection();
      const selectedText = selection && !selection.isCollapsed ? selection.toString() : "";

      // 无选中文本且未点在某行内容上，不弹发送菜单
      if (!selectedText.trim() && clickedLine === null) return;

      let startLine = clickedLine ?? 1;
      let endLine = clickedLine ?? 1;
      if (selectedText.trim() && selection) {
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
      }

      e.preventDefault();
      setTimeout(() => {
        setContextMenu({ x: e.clientX, y: e.clientY, selection: selectedText, startLine, endLine });
      }, 10);
    },
    [isImage]
  );

  const handleSendToChat = useCallback(() => {
    if (!contextMenu || !activeFilePath) return;
    const pendingFile = {
      id: crypto.randomUUID(),
      fileName,
      filePath: activeFilePath,
      startLine: contextMenu.startLine,
      endLine: contextMenu.endLine,
    };
    const inserted = requestComposerInsert({ node: { ...pendingFile, type: "snippet" } });
    if (!inserted) addPendingFile(pendingFile);
    setContextMenu(null);
  }, [contextMenu, activeFilePath, fileName, addPendingFile]);

  const handleMarkdownLinkClick = useCallback((href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!activeFilePath) return false;
    const targetFilePath = resolveMarkdownLinkPath(activeFilePath, href);
    if (!targetFilePath) return false;
    event.preventDefault();
    event.stopPropagation();
    setPreviewHistory((current) => [...current, targetFilePath]);
    return true;
  }, [activeFilePath]);

  if (!activeFilePath) return null;

  return (
    <div className="fp-overlay" onClick={handleClose}>
      <div className={`fp-modal ${isMarkdown ? "fp-has-toolbar" : ""}`} onClick={(e) => e.stopPropagation()}>
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
              onClick={() => {
                setPreviewMode(true);
                setSearchOpen(false);
                setGoToLineOpen(false);
              }}
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
        {searchOpen && (
          <div className="fp-find-widget" role="search">
            <input
              ref={searchInputRef}
              className={`fp-widget-input ${searchQuery && searchMatches.length === 0 ? "fp-widget-input-error" : ""}`}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                navigateSearch(event.shiftKey ? -1 : 1);
              }}
              placeholder="搜索"
              aria-label="搜索文件内容"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className={`fp-search-option-btn ${searchMatchCase ? "active" : ""}`}
              onClick={() => setSearchMatchCase((current) => !current)}
              title="区分大小写 (Alt+C)"
              aria-label="区分大小写"
              aria-pressed={searchMatchCase}
            >
              Aa
            </button>
            <button
              type="button"
              className={`fp-search-option-btn fp-whole-word ${searchWholeWord ? "active" : ""}`}
              onClick={() => setSearchWholeWord((current) => !current)}
              title="全字匹配 (Alt+W)"
              aria-label="全字匹配"
              aria-pressed={searchWholeWord}
            >
              ab
            </button>
            <span className="fp-find-count">
              {searchQuery && searchMatches.length === 0
                ? "无结果"
                : `${searchMatches.length > 0 ? activeMatchIndex + 1 : 0}/${searchMatches.length}`}
            </span>
            <button
              type="button"
              className="fp-widget-btn"
              onClick={() => navigateSearch(-1)}
              disabled={searchMatches.length === 0}
              title="上一个匹配项 (Shift+Enter)"
              aria-label="上一个匹配项"
            >
              ↑
            </button>
            <button
              type="button"
              className="fp-widget-btn"
              onClick={() => navigateSearch(1)}
              disabled={searchMatches.length === 0}
              title="下一个匹配项 (Enter)"
              aria-label="下一个匹配项"
            >
              ↓
            </button>
            <button
              type="button"
              className="fp-widget-btn"
              onClick={() => setSearchOpen(false)}
              title="关闭 (Esc)"
              aria-label="关闭搜索"
            >
              ×
            </button>
          </div>
        )}
        {goToLineOpen && (
          <div className="fp-find-widget fp-go-to-line-widget">
            <input
              ref={goToLineInputRef}
              className={`fp-widget-input ${goToLineError ? "fp-widget-input-error" : ""}`}
              value={goToLineValue}
              onChange={(event) => {
                setGoToLineValue(event.target.value);
                setGoToLineError(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submitGoToLine();
              }}
              placeholder={`跳转到行 (1 - ${totalLines})`}
              aria-label={`跳转到行，范围 1 到 ${totalLines}`}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
            />
            {goToLineError && <span className="fp-go-to-line-error">请输入 1 - {totalLines}</span>}
            <button
              type="button"
              className="fp-widget-btn"
              onClick={() => {
                setGoToLineOpen(false);
                setGoToLineError(false);
              }}
              title="关闭 (Esc)"
              aria-label="关闭跳行"
            >
              ×
            </button>
          </div>
        )}
        <div className="fp-content" onContextMenu={handleContextMenu}>
          {loading ? (
            <div className="fp-status">加载中...</div>
          ) : error ? (
            <div className="fp-status fp-error">{error}</div>
          ) : isBinary ? (
            <div className="fp-binary-notice">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M6 2H14L20 8V20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20V4C4 2.89543 4.89543 2 6 2Z" />
                <path d="M14 2V8H20" />
                <path d="M9 13L15 13M9 17L15 17" strokeLinecap="round" />
              </svg>
              <p className="fp-binary-title">无法显示内容</p>
              <p className="fp-binary-desc">该文件是二进制文件或使用了不受支持的文本编码，无法在编辑器中显示。</p>
            </div>
          ) : isImage ? (
            <div className="fp-image-preview">
              {imageSrc ? (
                <img src={imageSrc} alt={fileName} className="fp-image" />
              ) : (
                <div className="fp-status">无法显示图片</div>
              )}
            </div>
          ) : showMarkdownPreview ? (
            <div className="fp-markdown-preview">
              <ErrorBoundary key={activeFilePath} fallback={<div className="fp-status">Markdown 渲染失败，请切换到源码模式</div>}>
                <MarkdownRenderer content={markdownContent} onLinkClick={handleMarkdownLinkClick} />
              </ErrorBoundary>
            </div>
          ) : (
            <pre ref={contentRef} className="fp-text" data-file-path={activeFilePath}>
              {visibleLineIndexes.map((lineIndex) => {
                const lineNumber = lineIndex + 1;
                const lineMatches = searchOpen ? searchMatchesByLine.get(lineNumber) || [] : [];
                const displayTokens = buildDisplayTokens(highlightedLines[lineIndex] || [], lineMatches);
                return (
                  <div
                    key={lineNumber}
                    className={`fp-line ${jumpTargetLine === lineNumber ? "fp-line-jump-target" : ""}`}
                    data-line={lineNumber}
                  >
                    <span className="fp-line-number" data-line={lineNumber}>{lineNumber}</span>
                    <span className="fp-line-content" data-line={lineNumber}>
                      {displayTokens.map((token, tokenIndex) => {
                        const syntaxToken = (
                          <span className={token.classNames.join(" ") || undefined}>{token.text}</span>
                        );
                        if (token.matchIndex === undefined) {
                          return <span key={tokenIndex}>{syntaxToken}</span>;
                        }
                        return (
                          <mark
                            key={tokenIndex}
                            className={`fp-search-match ${token.matchIndex === activeMatchIndex ? "fp-search-match-current" : ""}`}
                          >
                            {syntaxToken}
                          </mark>
                        );
                      })}
                    </span>
                  </div>
                );
              })}
            </pre>
          )}
        </div>
        <div className="fp-footer">
          <span>{isImage ? "图片预览" : isBinary ? "二进制文件" : "右键当前行或选中内容可发送到聊天"}</span>
          {!isImage && totalLines > MAX_RENDER_LINES && (
            <span>当前显示第 {renderWindow.startIndex + 1} - {renderWindow.endIndex} 行，共 {totalLines} 行</span>
          )}
        </div>
      </div>

      {contextMenu && (
        <div className="fp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button className="fp-cm-btn" onClick={handleSendToChat}>
            <span className="fp-cm-btn-title">发送到聊天</span>
            <span className="fp-cm-btn-target">{fileName}:{contextMenu.startLine}-{contextMenu.endLine}</span>
          </button>
        </div>
      )}
    </div>
  );
}
