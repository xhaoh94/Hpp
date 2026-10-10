import type { ComposerDocument, ComposerNode } from "@shared/composer-document";
import { parseComposerDocument } from "@shared/composer-document";
import type { ChatMessage } from "@/stores/chat-store";

type PreviewMessage = Pick<ChatMessage, "content" | "composerDocument" | "composerDraft">;

const LEGACY_ATTACHMENT_TOKEN = /\[(?:file|folder):[^\]\r\n]+\]/g;

/**
 * 内部标签清洗。
 *
 * 历史消息没有 `composerDocument`（那是后来加的字段），`parseComposerDocument`
 * 会对裸字符串返回 undefined，预览就会**原样显示** content。而 content 里躺着
 * 发给 agent 的 XML：`<file path="G:\Work\...` 这样。加上 fork 的包裹标签，
 * 会话项上就出现整条原始标签。
 *
 * 只做替换、不改消息本身——原始 content 是要原样发给 agent 的。
 */
const INTERNAL_TAG_RULES: Array<{
  pattern: RegExp;
  /** 拿到完整匹配与捕获组，返回可读标签。 */
  label: (full: string, path: string) => string;
}> = [
  // 带正文的 <file path="..." lines="10-42">…</file> —— 收尾标签里的
  // "lines" 属性对应标签形态 `[file: name.lua:10-42]`。
  {
    pattern: /<file\s+[^>]*path="([^"]*)"[^>]*>([\s\S]*?)<\/file>/g,
    label: (full, path) => {
      const name = basenameOf(path);
      const lines = /\slines="(\d+)-(\d+)"/.exec(full);
      return lines ? `[file: ${name}:${lines[1]}-${lines[2]}]` : `[file: ${name}]`;
    },
  },
  // 自闭合的 image_attachment
  {
    pattern: /<image_attachment\s+[^>]*name="([^"]*)"[^>]*\/>/g,
    label: (_full, name) => `[image: ${basenameOf(name)}]`,
  },
  // fork 的会话来源（<source session_id="…" title="…" … />）
  {
    pattern: /<source\s+[^>]*title="([^"]*)"[^>]*\/>/g,
    label: (_full, title) => `[引用会话: ${title}]`,
  },
];

/**
 * 取路径末段。
 * 发送侧统一用正斜杠，但 Windows 上用户可能手输反斜杠，所以两种分隔符都认。
 * 注意不要先strip 尾部斜杠 —— `G:\Work\a.ts` 里的 `a` 不能被当成空段吃掉。
 */
function basenameOf(rawPath: string): string {
  const cleaned = String(rawPath || "");
  const segment = cleaned.split(/[\\/]/).filter(Boolean).pop() || "";
  return segment || cleaned;
}

/** 把裸 content 里的内部 XML 标签换成可读的 [文件名] 形式。 */
export function stripInternalTags(content: string): string {
  let result = content;
  for (const rule of INTERNAL_TAG_RULES) {
    result = result.replace(rule.pattern, (full, ...rest) => rule.label(full, String(rest[0] ?? "")));
  }
  return result;
}

/**
 * 剥掉只剩包裹作用的标签（fork 的 <current_user_message> 之类）。
 * 这些标签本身不携带信息，预览里没有意义，但留着会被当成标题显示。
 */
const WRAPPER_TAG = /<\/?(?:current_user_message|fork_context|message|conversation)>/g;

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

  // 历史消息走这里。裸 content 里可能有内部 XML 标签（fork 上下文、file 正文、
  // 图片附件），原样显示会让会话项变成一串 `G:\Work\...`。
  const content = compactWhitespace(stripInternalTags(message.content || "").replace(WRAPPER_TAG, ""));
  if (!content) return "";

  const textWithoutAttachments = compactWhitespace(content.replace(LEGACY_ATTACHMENT_TOKEN, " "));
  return textWithoutAttachments || content;
}
