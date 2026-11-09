import type { ComposerDocument, ComposerNode } from "@shared/composer-document";
import { getComposerNodeLabel, parseComposerDocument } from "@shared/composer-document";
import { MESSAGE_WRAPPER_TAG, stripInternalTags } from "@shared/message-internal-tags";
import type { ChatMessage } from "@/stores/chat-store";

type PreviewMessage = Pick<ChatMessage, "content" | "composerDocument" | "composerDraft" | "images">;

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

/**
 * 预览里的附件写法：
 * - `inline`：聊天正文/发言记录里用带类型的写法（`[file: a.ts]`、`[图片]`），
 *   和正文的观感一致；
 * - `session`：标题栏、页签、历史会话列表用短标签（`[a.ts]`、`[shot.png]`、`[src]`），
 *   一眼能看出这条会话带了哪些附件。
 */
type PreviewStyle = "inline" | "session";

// 标题类位置最多列这么多个附件，再多就用省略号，避免页签被撑爆。
const MAX_SESSION_LABELS = 4;

type PreviewOptions = {
  style: PreviewStyle;
  /** 标题类位置最多列几个附件（会话标题只需要一个）。 */
  maxLabels?: number;
  /** 超过 maxLabels 时是否加省略号；标题位置直接截掉。 */
  ellipsis?: boolean;
};

const getNodeFallbackLabel = (node: Exclude<ComposerNode, { type: "text" }>, style: PreviewStyle) => {
  // 粘贴块在预览里一律只写体量，不把原文抖到标题栏/会话列表里。
  if (node.type === "paste") return getComposerNodeLabel(node);
  if (style === "session") {
    if (node.type === "path") return `[${node.name}]`;
    if (node.type === "snippet") return `[${node.fileName}:${node.startLine}-${node.endLine}]`;
    if (node.type === "session") return `[${node.reference.sourceTitle}]`;
    return `[${node.name}]`;
  }
  if (node.type === "path") return `[${node.kind}: ${node.name}]`;
  if (node.type === "snippet") return `[file: ${node.fileName}:${node.startLine}-${node.endLine}]`;
  if (node.type === "session") return `${node.reference.sourceTitle}`;
  return "[图片]";
};

/** 图片占位标签：inline 写「[图片]」，session 直接写文件名。 */
const getImagePreviewLabel = (count: number, style: PreviewStyle) => {
  if (count <= 0) return "";
  if (style === "session") return "";
  return count === 1 ? "[图片]" : `[图片 × ${count}]`;
};

const joinSessionLabels = (
  labels: string[],
  maxLabels = MAX_SESSION_LABELS,
  ellipsis = true,
) => {
  const visible = labels.filter(Boolean);
  if (visible.length <= maxLabels) return visible.join("");
  const head = visible.slice(0, maxLabels).join("");
  return ellipsis ? `${head}…` : head;
};

const getImageSessionLabels = (
  images: PreviewMessage["images"],
  maxLabels = MAX_SESSION_LABELS,
  ellipsis = true,
) => joinSessionLabels((images || []).map((image) => `[${image.name}]`), maxLabels, ellipsis);

function getDocumentPreview(document: ComposerDocument, options: PreviewOptions): string {
  const { style, maxLabels, ellipsis = true } = options;
  // Compact titles should describe the user's request instead of being
  // consumed by a long attachment name that precedes the text.
  const text = compactWhitespace(document.nodes
    .filter((node) => node.type === "text")
    .map((node) => node.text)
    .join(" "));
  if (text) return text;

  const attachmentNodes = document.nodes.filter(
    (node): node is Exclude<ComposerNode, { type: "text" }> => node.type !== "text",
  );
  if (attachmentNodes.length === 0) return "";

  const imageCount = attachmentNodes.filter((node) => node.type === "image").length;

  if (style === "session") {
    const labels = attachmentNodes.map((node) => getNodeFallbackLabel(node, style));
    // 图片节点没有可用的 name 时退回「[图片]」，至少不会空白。
    return joinSessionLabels(labels.map((label) => (label === "[]" ? "[图片]" : label)), maxLabels, ellipsis);
  }

  // 聊天内：只有图片时统一写「[图片]」，不把文件名塞进正文预览。
  if (imageCount > 0 && imageCount === attachmentNodes.length) {
    return getImagePreviewLabel(imageCount, style);
  }

  return compactWhitespace(attachmentNodes.map((node) => getNodeFallbackLabel(node, style)).join(" "));
}

function buildPreviewText(message: PreviewMessage, options: PreviewOptions): string {
  const { style, maxLabels, ellipsis = true } = options;
  const document = parseComposerDocument(message.composerDocument)
    || parseComposerDocument(message.composerDraft?.document);
  if (document) {
    const preview = getDocumentPreview(document, options);
    if (preview) return preview;
  }

  // 历史消息走这里。裸 content 里可能有内部 XML 标签（fork 上下文、file 正文、
  // 图片附件），原样显示会让会话项变成一串 `G:\Work\...`。
  const content = compactWhitespace(stripInternalTags(message.content || "").replace(MESSAGE_WRAPPER_TAG, ""));
  const imageCount = message.images?.length ?? 0;
  const imageLabels = style === "session" ? getImageSessionLabels(message.images, maxLabels, ellipsis) : "";
  if (!content) return imageLabels || getImagePreviewLabel(imageCount, style);

  const textWithoutAttachments = compactWhitespace(content.replace(LEGACY_ATTACHMENT_TOKEN, " "));
  if (!textWithoutAttachments) {
    return imageLabels || getImagePreviewLabel(imageCount, style) || content;
  }
  return textWithoutAttachments;
}

/** 聊天正文 / 发言记录里的预览（保持既有观感）。 */
export function getChatMessagePreviewText(message: PreviewMessage): string {
  return buildPreviewText(message, { style: "inline" });
}

/**
 * 标题栏 / 页签 / 历史会话列表里的预览：只有附件时列出具体名字
 * （`[shot.png]`、`[src]`、`[a.ts:3-9]`），而不是笼统的「[图片]」或空白。
 * 有文字时仍然以文字为准。
 *
 * `maxLabels` 用于会话标题这种窄位置（只取第一个附件名）。
 */
export function getSessionPreviewLabel(
  message: PreviewMessage,
  options: { maxLabels?: number } = {},
): string {
  return buildPreviewText(message, {
    style: "session",
    maxLabels: options.maxLabels,
    // 标题位只需一个名字，多出来的直接截掉，不用省略号占位。
    ellipsis: options.maxLabels === undefined,
  });
}
