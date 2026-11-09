import { memo, useMemo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { buildFencedCode, formatCodeForDisplay } from "@/lib/user-message-code";
import "./UserCodeBlock.css";

type UserCodeBlockProps = {
  code: string;
  /** 语言标签（猜不出来时留空，代码块照常渲染，只是没有语法高亮和语言名）。 */
  language?: string;
  /** 处理面板等窄场景用的紧凑尺寸。 */
  compact?: boolean;
  projectPath?: string;
  onFileOpen?: (path: string) => void;
};

/**
 * 用户发言里的代码块。
 *
 * 复用 MarkdownRenderer 的代码块能力（语言标签、复制、运行、语法高亮），
 * 但只喂给它一段包好的围栏代码，用户消息本身仍然不走 Markdown 解析，
 * 避免 `#`、`*` 之类把用户的原话改得面目全非。
 *
 * 粘贴来的代码经常带着断掉的缩进（从编辑器/网页复制时被吞），所以展示前会
 * 按花括号层级重排一次行首空白；只影响显示，发送给 Agent 的仍是原文。
 */
export const UserCodeBlock = memo(function UserCodeBlock({
  code,
  language = "",
  compact = false,
  projectPath,
  onFileOpen,
}: UserCodeBlockProps) {
  const content = useMemo(
    () => buildFencedCode(formatCodeForDisplay(code, language), language),
    [code, language],
  );
  return (
    <div className={`chat-user-code-block${compact ? " compact" : ""}`}>
      <MarkdownRenderer content={content} projectPath={projectPath} onFileOpen={onFileOpen} />
    </div>
  );
});
