import type { ComposerDocument, ComposerNode } from "@shared/composer-document";
import { parseComposerDocument } from "@shared/composer-document";
import type { ChatMessage } from "@/stores/chat-store";

type PreviewMessage = Pick<ChatMessage, "content" | "composerDocument" | "composerDraft">;

const LEGACY_ATTACHMENT_TOKEN = /\[(?:file|folder):[^\]\r\n]+\]/g;

const compactWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

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

  const content = compactWhitespace(message.content || "");
  if (!content) return "";

  const textWithoutAttachments = compactWhitespace(content.replace(LEGACY_ATTACHMENT_TOKEN, " "));
  return textWithoutAttachments || content;
}
