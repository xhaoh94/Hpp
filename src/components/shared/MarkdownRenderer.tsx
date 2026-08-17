import { isValidElement, memo, useCallback, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getLocalMarkdownCodePath } from "@/lib/project-file-path";
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

interface MarkdownRendererProps {
  content: string;
  onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => boolean | void;
}

function MarkdownRendererImpl({ content, onLinkClick }: MarkdownRendererProps) {
  return (
    <div className="md-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ node, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const language = match ? match[1] : "";
            // react-markdown 解析代码块时 children 末尾总会带一个 \n，
            // 复制时去掉它，避免剪贴板内容尾部多一个换行。
            const text = getTextContent(children).replace(/\r?\n$/, "");

            // Inline code (no language = no newline = likely inline)
            if (!language && !text.includes("\n")) {
              const localPath = getLocalMarkdownCodePath(text);
              return (
                <code className={`md-inline-code${localPath ? " md-path-reference" : ""}`} {...props}>
                  {children}
                </code>
              );
            }

            // Code block
            // 横向滚动容器（pre）自身的左右 padding 在 Chromium 中会被"吞掉"，
            // 故在其外套一层不滚动的 wrapper 负责四边间距，pre 内部 padding 为 0。
            // 语言标签与复制按钮放在独立的 header 行，不再用 absolute 悬浮在内容上方，
            // 从根本上避免标签与长内容重叠，同时 wrapper 的左右 padding 可统一为 24px。
            return (
              <div className={`md-code-block${language ? " md-code-block--with-lang" : ""}`}>
                <div className="md-code-header">
                  {language ? (
                    <div className="md-code-lang">{language}</div>
                  ) : (
                    <span />
                  )}
                  <CopyButton text={text} />
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
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="md-link"
                onClick={(event) => {
                  if (href) onLinkClick?.(href, event);
                }}
              >
                {children}
              </a>
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
