import type {
  PendingFile,
  PendingPathAttachment,
  QueuedMessageImage,
} from "@/stores/chat-store";
import type { SessionReference } from "@/stores/project-store";
import type { PreparedSessionMessage } from "@/lib/session-command-coordinator";
import { buildSessionReferencesContext } from "@/lib/session-references";
import type { AgentActionInvocation } from "@shared/agent-actions";

const escapeXmlAttribute = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const buildPathAttachmentBlock = (attachments: PendingPathAttachment[]) => {
  if (attachments.length === 0) return "";
  return [
    "<attached_paths>",
    ...attachments.map((attachment) => {
      const tag = attachment.kind === "folder" ? "folder" : "file";
      return `<${tag} path="${escapeXmlAttribute(attachment.path)}" />`;
    }),
    "</attached_paths>",
  ].join("\n");
};

export type BuildSessionMessagePayloadInput = {
  text: string;
  images: QueuedMessageImage[];
  pendingFiles: PendingFile[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
  forkContext?: string;
  action?: AgentActionInvocation;
  readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>;
};

export async function buildSessionMessagePayload(
  input: BuildSessionMessagePayloadInput,
): Promise<PreparedSessionMessage> {
  const rawText = input.text;
  const text = rawText.trim();
  let displayContent = text;
  let sendContent = text;

  if (input.pendingFiles.length > 0) {
    const fileParts: string[] = [];
    const fileRefs: string[] = [];
    for (const file of input.pendingFiles) {
      fileRefs.push(`[${file.fileName}:${file.startLine}-${file.endLine}]`);
      try {
        const result = await input.readFile(file.filePath);
        if (result.success && typeof result.content === "string") {
          const selectedLines = result.content.split("\n").slice(file.startLine - 1, file.endLine);
          fileParts.push(`<file path="${escapeXmlAttribute(file.filePath)}" lines="${file.startLine}-${file.endLine}">\n${selectedLines.join("\n")}\n</file>`);
        } else {
          fileParts.push(`[无法读取文件: ${file.fileName}]`);
        }
      } catch {
        fileParts.push(`[无法读取文件: ${file.fileName}]`);
      }
    }
    const refs = fileRefs.join(" ");
    displayContent = displayContent ? `${displayContent}\n${refs}` : refs;
    sendContent = sendContent ? `${sendContent}\n\n${fileParts.join("\n\n")}` : fileParts.join("\n\n");
  }

  if (input.pendingPathAttachments.length > 0) {
    const refs = input.pendingPathAttachments
      .map((attachment) => `[${attachment.kind}: ${attachment.name}]`)
      .join(" ");
    const block = buildPathAttachmentBlock(input.pendingPathAttachments);
    displayContent = displayContent ? `${displayContent}\n${refs}` : refs;
    sendContent = sendContent ? `${sendContent}\n\n${block}` : block;
  }

  const contextBlocks = [
    input.forkContext,
    buildSessionReferencesContext(input.sessionReferences),
  ].filter((value): value is string => !!value);
  if (contextBlocks.length > 0) {
    sendContent = [
      ...contextBlocks,
      "",
      "<current_user_message>",
      sendContent,
      "</current_user_message>",
    ].join("\n");
  }

  const messageImages = input.images.length > 0
    ? input.images.map(({ id, src, name }) => ({ id, src, name }))
    : undefined;
  const agentImages = input.images.length > 0
    ? input.images.map((image) => ({
        type: "image",
        data: image.src.includes(",") ? image.src.slice(image.src.indexOf(",") + 1) : image.src,
        mimeType: image.mimeType || "image/png",
      }))
    : undefined;
  const sessionReferences = input.sessionReferences.length > 0
    ? input.sessionReferences.map((reference) => ({
        sourceSessionId: reference.sourceSessionId,
        sourceTitle: reference.sourceTitle,
      }))
    : undefined;

  return {
    editableContent: text,
    displayContent,
    sendContent,
    messageImages,
    sessionReferences,
    agentImages,
    forkContextUsed: !!input.forkContext,
    action: input.action,
    editableDraft: {
      text: rawText,
      images: input.images,
      pendingFiles: input.pendingFiles,
      pendingPathAttachments: input.pendingPathAttachments,
      sessionReferences: input.sessionReferences,
      forkContext: input.forkContext,
      action: input.action,
    },
  };
}
