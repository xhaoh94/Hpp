import { memo, useMemo } from "react";
import { planUserMessageCode, type UserMessageCodePlan } from "@/lib/user-message-code";
import { UserCodeBlock } from "./UserCodeBlock";

type UserMessageTextProps = {
  text: string;
  /** 纯文本段沿用调用方既有的样式类（气泡 / 处理面板各有自己的字号）。 */
  textClassName?: string;
  compact?: boolean;
  projectPath?: string;
  onFileOpen?: (path: string) => void;
  /** 上层已经算好的切分结果（避免同一段文本在渲染路径里重复识别）。 */
  plan?: UserMessageCodePlan;
  /**
   * 是否允许无围栏时的整段自动识别。只有「整条消息都是文本」时才该开启，
   * 夹着附件芯片的消息关掉，免得把正文里的一小段文字渲染成代码块。
   */
  autoDetect?: boolean;
};

/**
 * 用户发言正文：默认仍是纯文本，只有 ` ``` ` 围栏或整段明确是代码时才换成
 * 代码块。用户消息刻意不走 Markdown 解析（见移动端既有注释），这里只做
 * 「代码 → 代码块」这一件事。
 */
export const UserMessageText = memo(function UserMessageText({
  text,
  textClassName,
  compact = false,
  projectPath,
  onFileOpen,
  plan: planProp,
  autoDetect = true,
}: UserMessageTextProps) {
  const computedPlan = useMemo(
    () => planProp ?? planUserMessageCode(text, { autoDetect }),
    [autoDetect, planProp, text],
  );
  const plan = computedPlan;

  if (plan.kind === "plain") {
    return <span className={textClassName}>{text}</span>;
  }

  return (
    <span className={`chat-user-code-flow${compact ? " compact" : ""}`}>
      {plan.segments.map((segment, index) => (segment.type === "code" ? (
        <UserCodeBlock
          key={`code-${index}`}
          code={segment.code}
          language={segment.language}
          compact={compact}
          projectPath={projectPath}
          onFileOpen={onFileOpen}
        />
      ) : (
        <span key={`text-${index}`} className={textClassName}>{segment.text}</span>
      )))}
    </span>
  );
});
