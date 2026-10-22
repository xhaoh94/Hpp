import {
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getLocalMarkdownCodePath,
  getLocalMarkdownFilePath,
  isExternalMarkdownHref,
  resolveProjectFilePath,
} from "@/lib/project-file-path";
import { getRunnableCodeKind } from "@/lib/runnable-code";
import { FileContextMenu, type FileContextMenuState } from "./FileContextMenu";
import { splitMarkdownChunks } from "./markdown-chunks";
import "./MarkdownRenderer.css";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [text]);

  return (
    <button className="md-code-copy-btn" onClick={handleCopy} title="复制代码">
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function getLanguage(children: ReactNode): string {
  if (!isValidElement<{ className?: string }>(children)) return "";
  const props = children.props;
  const cls = props.className || "";
  const match = String(cls).match(/language-(\w+)/);
  return match ? match[1] : "";
}

function getTextContent(children: ReactNode): string {
  if (children === null || children === undefined) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(getTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return getTextContent(children.props.children);
  }
  return "";
}

function RunButton({ text, language }: { text: string; language: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleRun = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setState("running");
    try {
      const result = await window.electronAPI.runHtmlPreview({ code: text, language });
      if (result?.success) {
        setState("done");
        timerRef.current = setTimeout(() => setState("idle"), 1500);
      } else {
        setError(result?.error || "运行失败");
        setState("error");
        timerRef.current = setTimeout(() => setState("idle"), 2500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
      timerRef.current = setTimeout(() => setState("idle"), 2500);
    }
  }, [text, language]);

  const title = state === "error" && error
    ? `本地运行失败：${error}`
    : `本地运行 ${language.toUpperCase()}`;

  return (
    <button
      className="md-code-run-btn"
      onClick={handleRun}
      disabled={state === "running"}
      title={title}
    >
      {state === "done" ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : state === "error" ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
      )}
    </button>
  );
}

interface MarkdownRendererProps {
  content: string;
  onLinkClick?: (href: string, event: ReactMouseEvent<HTMLAnchorElement>) => boolean | void;
  /** 相对路径链接按哪个项目根解析；不传时只有绝对路径链接可定位。 */
  projectPath?: string;
  /** 流式输出期间跳过代码高亮，等内容稳定后再执行 rehype-highlight。 */
  deferHighlight?: boolean;
}

// 默认的 URL 清洗只放行协议白名单，会把 Windows 盘符路径（`E:\a\b.lua`、`C:/a/b.lua`）
// 整条清成空串；空的 href 会解析成「当前页面」，点一下就把应用自己再开一个窗口。
// 这里只拦真正的脚本协议，本地路径原样保留给点击处理器。
const SCRIPT_HREF = /^\s*(?:javascript|data|vbscript):/i;

function keepLocalHref(url: string): string {
  return SCRIPT_HREF.test(url) ? "" : url;
}

// react-markdown 不做任何内部缓存：每次渲染都会拿这些 options 重建解析器。
// 把插件与组件表提升为模块级常量，避免它们每次渲染都是新引用。
const REMARK_PLUGINS = [remarkGfm];
type RehypeHighlightPlugin = typeof import("rehype-highlight").default;
let rehypeHighlightPlugin: RehypeHighlightPlugin | null = null;
let rehypeHighlightPromise: Promise<RehypeHighlightPlugin> | null = null;

const loadRehypeHighlight = () => {
  if (rehypeHighlightPlugin) return Promise.resolve(rehypeHighlightPlugin);
  rehypeHighlightPromise ||= import("rehype-highlight").then((module) => {
    rehypeHighlightPlugin = module.default;
    return module.default;
  });
  return rehypeHighlightPromise;
};

function useRehypeHighlight(enabled: boolean) {
  const [plugin, setPlugin] = useState<RehypeHighlightPlugin | null>(() => rehypeHighlightPlugin);

  useEffect(() => {
    if (!enabled || plugin) return;
    let cancelled = false;
    void loadRehypeHighlight().then((loaded) => {
      // 插件本身就是函数，直接 setPlugin(loaded) 会被 React 当作 state updater
      // 调用，存下的是 rehypeHighlight(prevState) 的返回值（transformer）。
      if (!cancelled) setPlugin(() => loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, plugin]);

  return plugin;
}

// 链接点击处理器通过 context 下发，这样组件表可以完全稳定，分块渲染时
// 各块之间也不需要重复传递回调。
const MarkdownLinkClickContext = createContext<MarkdownRendererProps["onLinkClick"]>(undefined);
const MarkdownProjectPathContext = createContext<string | undefined>(undefined);

// 同一时刻只开一个链接菜单：新菜单打开时关掉上一个。
let closeActiveLinkMenu: (() => void) | null = null;

interface LinkMenuState {
  x: number;
  y: number;
  href: string;
  external: boolean;
  localPath: string | null;
}

function LinkContextMenu({ state, onClose }: { state: LinkMenuState; onClose: () => void }) {
  useEffect(() => {
    closeActiveLinkMenu?.();
    closeActiveLinkMenu = onClose;
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".md-link-menu")) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      if (closeActiveLinkMenu === onClose) closeActiveLinkMenu = null;
    };
  }, [onClose]);

  // 简单防溢出：估算菜单尺寸，贴住视口右下角。
  const left = Math.min(state.x, window.innerWidth - 220);
  const top = Math.min(state.y, window.innerHeight - 140);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 复制失败不阻塞菜单关闭
    }
    onClose();
  }, [onClose]);

  return createPortal(
    <div className="md-link-menu" style={{ left, top }} role="menu">
      {state.external ? (
        <button
          type="button"
          className="md-link-menu-item"
          role="menuitem"
          onClick={() => {
            window.open(state.href, "_blank", "noopener,noreferrer");
            onClose();
          }}
        >
          打开链接
        </button>
      ) : null}
      <button
        type="button"
        className="md-link-menu-item"
        role="menuitem"
        onClick={() => void copyText(state.href)}
      >
        复制链接地址
      </button>
    </div>,
    document.body,
  );
}

const MARKDOWN_COMPONENTS: Components = {
  code({ node, className, children, ...props }) {
    const projectPath = useContext(MarkdownProjectPathContext);
    const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
    const match = /language-(\w+)/.exec(className || "");
    const language = match ? match[1] : "";
    // react-markdown 解析代码块时 children 末尾总会带一个 \n，
    // 复制时去掉它，避免剪贴板内容尾部多一个换行。
    const text = getTextContent(children).replace(/\r?\n$/, "");

    // Inline code (no language = no newline = likely inline)
    if (!language && !text.includes("\n")) {
      const localPath = getLocalMarkdownCodePath(text);
      const resolvedPath = localPath
        ? (projectPath ? resolveProjectFilePath(localPath, projectPath) : localPath)
        : null;
      return (
        <>
          <code
            className={`md-inline-code${localPath ? " md-path-reference" : ""}`}
            {...props}
            onContextMenu={resolvedPath ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ x: event.clientX, y: event.clientY, path: resolvedPath });
            } : undefined}
          >
            {children}
          </code>
          {contextMenu && (
            <FileContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              path={contextMenu.path}
              projectPath={projectPath}
              onClose={() => setContextMenu(null)}
            />
          )}
        </>
      );
    }

    // Code block
    // 横向滚动容器（pre）自身的左右 padding 在 Chromium 中会被"吞掉"，
    // 故在其外套一层不滚动的 wrapper 负责四边间距，pre 内部 padding 为 0。
    // 语言标签与复制按钮放在独立的 header 行，不再用 absolute 悬浮在内容上方，
    // 从根本上避免标签与长内容重叠，同时 wrapper 的左右 padding 可统一为 24px。
    const runnableKind = getRunnableCodeKind(language, text);
    return (
      <div className={`md-code-block${language ? " md-code-block--with-lang" : ""}`}>
        <div className="md-code-header">
          {language ? (
            <div className="md-code-lang">{language}</div>
          ) : (
            <span />
          )}
          <div className="md-code-actions">
            {runnableKind && <RunButton text={text} language={runnableKind} />}
            <CopyButton text={text} />
          </div>
        </div>
        <div
          className="md-code-scroll-wrapper"
          style={{
            boxSizing: "border-box",
            width: "100%",
            padding: "4px 24px 8px 24px",
          }}
        >
          <pre style={{
            boxSizing: "border-box",
            margin: 0,
            padding: 0,
            overflowX: "auto",
            maxWidth: "100%",
          }}>
            <code
              className={className}
              {...props}
              style={{
                display: "block",
                whiteSpace: "pre",
                padding: 0,
              }}
            >
              {children}
            </code>
          </pre>
        </div>
      </div>
    );
  },
  a({ href, children, ...props }) {
    const onLinkClick = useContext(MarkdownLinkClickContext);
    const projectPath = useContext(MarkdownProjectPathContext);
    // 只有 http(s) 交给系统浏览器（主进程的 setWindowOpenHandler 会接管），
    // 其余 href 一律拦掉默认跳转，否则 Electron 会新开一个没有 preload 的空白窗口。
    const external = isExternalMarkdownHref(href);
    const [menu, setMenu] = useState<LinkMenuState | null>(null);

    const localPath = useMemo(() => {
      if (external || !href) return null;
      const local = getLocalMarkdownFilePath(href);
      if (!local) return null;
      return projectPath ? resolveProjectFilePath(local, projectPath) : local;
    }, [href, external, projectPath]);

    const openMenu = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!href) return;
      setMenu({ x: event.clientX, y: event.clientY, href, external, localPath });
    }, [href, external, localPath]);

    return (
      <>
        <a
          {...props}
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="md-link"
          onClick={(event) => {
            if (href && onLinkClick?.(href, event)) return;
            if (!external) event.preventDefault();
          }}
          onContextMenu={openMenu}
        >
          {children}
        </a>
        {menu && (
          menu.localPath ? (
            <FileContextMenu
              x={menu.x}
              y={menu.y}
              path={menu.localPath}
              projectPath={projectPath}
              onClose={() => setMenu(null)}
            />
          ) : (
            <LinkContextMenu
              state={menu}
              onClose={() => setMenu(null)}
            />
          )
        )}
      </>
    );
  },
  table({ children, ...props }) {
    return (
      <div className="md-table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  },
  input({ checked, ...props }) {
    // Render task list checkboxes as disabled (display only)
    return (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="md-task-checkbox"
        {...props}
      />
    );
  },
};

/**
 * 单块渲染。分块后流式期间只有尾部块的内容会变，其余块命中 memo，
 * 不再重复走 remark → rehype → 高亮。
 */
const MarkdownChunk = memo(function MarkdownChunk({
  content,
  enableHighlight,
  highlightPlugin,
}: {
  content: string;
  enableHighlight: boolean;
  highlightPlugin: RehypeHighlightPlugin | null;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={enableHighlight && highlightPlugin ? [highlightPlugin] : undefined}
      urlTransform={keepLocalHref}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

function MarkdownRendererImpl({
  content,
  onLinkClick,
  projectPath,
  deferHighlight = false,
}: MarkdownRendererProps) {
  // 切分是 O(长度) 的字符串扫描（微秒级），远低于一次 Markdown 解析，
  // 但能换来「已写完的前缀块不重新解析」。
  const chunks = useMemo(() => splitMarkdownChunks(content), [content]);
  const enableHighlight = !deferHighlight;
  const highlightPlugin = useRehypeHighlight(enableHighlight);
  return (
    <div className="md-content">
      <MarkdownLinkClickContext.Provider value={onLinkClick}>
        <MarkdownProjectPathContext.Provider value={projectPath}>
          {chunks.map((chunk, index) => (
            <MarkdownChunk
              key={index}
              content={chunk}
              enableHighlight={enableHighlight}
              highlightPlugin={highlightPlugin}
            />
          ))}
        </MarkdownProjectPathContext.Provider>
      </MarkdownLinkClickContext.Provider>
    </div>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
