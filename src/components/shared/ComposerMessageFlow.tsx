import { memo, useMemo } from "react";
import type { ComposerDocument } from "@shared/composer-document";
import { planUserMessageCode, type UserMessageCodePlan } from "@/lib/user-message-code";
import { ComposerEntityIcon } from "./ComposerEntityIcon";
import { ComposerPasteChip } from "./ComposerPasteChip";
import { UserMessageText } from "./UserMessageText";
import { openVideoPreview } from "@/lib/media-preview";
import { VideoThumbnail } from "./VideoThumbnail";

type ComposerMessageFlowProps = {
  document: ComposerDocument;
  onOpenImage?: (src: string) => void;
  onOpenVideo?: (path: string) => void;
  /** 代码块里的本地路径点击（可选，不传则只读展示）。 */
  projectPath?: string;
  onOpenFile?: (path: string) => void;
  /** 处理面板等窄场景用的紧凑代码块。 */
  compactCode?: boolean;
};

export const ComposerMessageFlow = memo(function ComposerMessageFlow({
  document,
  onOpenImage,
  onOpenVideo,
  projectPath,
  onOpenFile,
  compactCode = false,
}: ComposerMessageFlowProps) {
  /**
   * 先算一次每段文本的渲染计划：
   * - 整条消息只有一段文本时允许「无围栏自动识别代码」；
   * - 夹着附件芯片时只认显式 ``` 围栏，不倒腾行内排版。
   */
  const textPlans = useMemo(() => {
    const singleTextMessage = document.nodes.length === 1 && document.nodes[0].type === "text";
    const plans = new Map<string, UserMessageCodePlan>();
    for (const node of document.nodes) {
      if (node.type !== "text") continue;
      plans.set(node.id, planUserMessageCode(node.text, { autoDetect: singleTextMessage }));
    }
    const hasCodeBlock = Array.from(plans.values()).some((plan) => plan.kind === "segments");
    return { plans, hasCodeBlock, singleTextMessage };
  }, [document]);

  return (
    <span className={`composer-message-flow${textPlans.hasCodeBlock ? " has-code" : ""}`}>
      {document.nodes.map((node) => {
        if (node.type === "text") {
          return (
            <UserMessageText
              key={node.id}
              text={node.text}
              plan={textPlans.plans.get(node.id)}
              textClassName="composer-message-text"
              autoDetect={textPlans.singleTextMessage}
              compact={compactCode}
              projectPath={projectPath}
              onFileOpen={onOpenFile}
            />
          );
        }
        if (node.type === "image") {
          return (
            <button
              type="button"
              className="composer-message-image"
              key={node.id}
              title={node.name}
              onClick={() => onOpenImage?.(node.src)}
            >
              <img src={node.src} alt={node.name} />
              <span className="composer-message-image-label">Image</span>
            </button>
          );
        }
        if (node.type === "video") {
          // 视频在消息气泡里是独立的媒体块（chat-videos），不在正文流里重复一行。
          return null;
        }
        if (node.type === "paste") {
          // 粘贴的长文本只留标签，悬停/点击展开全文（发送给 Agent 的仍是原文）。
          return <ComposerPasteChip key={node.id} text={node.text} variant="message" />;
        }
        const label = node.type === "session"
          ? `引用会话: ${node.reference.sourceTitle}`
          : node.type === "snippet"
            ? `${node.fileName}:${node.startLine}-${node.endLine}`
            : node.name;
        return <span key={node.id} className={`composer-message-entity ${node.type}`}><ComposerEntityIcon node={node} /><span>{label}</span></span>;
      })}
    </span>
  );
});
