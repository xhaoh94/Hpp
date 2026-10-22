import type { ComposerDocument, ComposerNode } from "@shared/composer-document";
import { parseComposerDocument } from "@shared/composer-document";
import { MESSAGE_WRAPPER_TAG, stripInternalTags } from "@shared/message-internal-tags";
import type { ChatMessage } from "@/stores/chat-store";

type PreviewMessage = Pick<ChatMessage, "content" | "composerDocument" | "composerDraft">;

const LEGACY_ATTACHMENT_TOKEN = /\[(?:file|folder):[^\]\r\n]+\]/g;

// 内部标签规则（信封 XML → 可读标签）在 shared 里，桌面端与移动端共用同一份，
// 这里只负责「预览」语义：压缩空白、去掉纯包裹标签与展示用附件标签。
export { stripInternalTags };

const compactWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * 持久化的会话 preview 可能来自旧版本（当时裸 content 里的内部 XML 未清洗），
 * 显示前再兜底清洗一次，避免侧栏标题直接露出 `<file path="G:\..." />`。
 */
export function sanitizeSessionPreview(value: string): string {
  return compactWhitespace(stripInternalTags(value).replace(MESSAGE_WRAPPER_TAG, ""));
}

const getNodeFallbackLabel = (node: Exclude<ComposerNode, { type: "text" }>) => {
  if (node.type === "path") return `[${node.kind}: ${node.name}]`;
  if (node.type === "snippet") return `[file: ${node.fileName}:${node.startLine}-${node.endLine}]`;
  if (node.type === "session") return `${node.reference.sourceTitle}`;
  return "Image";
};

function getDocumentPreview(document: ComposerDocument): string {
  // Compact titles should describe the user's request instead of being
  // consumed by a long attachment name that precedes the text.
  const text = compactWhitespace(document.nodes
    .filter((node) => node.type === "text")
    .map((node) => node.text)
    .join(" "));
  if (text) return text;

  return compactWhitespace(document.nodes
    .filter((node): node is Exclude<ComposerNode, { type: "text" }> => node.type !== "text")
    .map(getNodeFallbackLabel)
    .join(" "));
}

/** Returns a compact preview for session tabs and message history. */
export function getChatMessagePreviewText(message: PreviewMessage): string {
  const document = parseComposerDocument(message.composerDocument)
    || parseComposerDocument(message.composerDraft?.document);
  if (document) {
    const preview = getDocumentPreview(document);
    if (preview) return preview;
  }

  // 历史消息走这里。裸 content 里可能有内部 XML 标签（fork 上下文、file 正文、
  // 图片附件），原样显示会让会话项变成一串 `G:\Work\...`。
  const content = compactWhitespace(stripInternalTags(message.content || "").replace(MESSAGE_WRAPPER_TAG, ""));
  if (!content) return "";

  const textWithoutAttachments = compactWhitespace(content.replace(LEGACY_ATTACHMENT_TOKEN, " "));
  return textWithoutAttachments || content;
}
