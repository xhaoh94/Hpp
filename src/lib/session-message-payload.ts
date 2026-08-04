import type {
  PendingFile,
  PendingPathAttachment,
  QueuedMessageImage,
} from "@/stores/chat-store";
import type { SessionReference } from "@/stores/project-store";
import type { PreparedSessionMessage } from "@/lib/session-command-coordinator";
import { buildSessionReferencesContext } from "@/lib/session-references";
import type { AgentActionInvocation } from "@shared/agent-actions";
import {
  cloneComposerDocument,
  createComposerDocument,
  getComposerImageNodes,
  getComposerNodeLabel,
  getComposerPlainText,
  withoutComposerImages,
  type ComposerDocument,
  type ComposerNode,
  type ComposerSessionReference,
} from "@shared/composer-document";

const escapeXmlAttribute = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const legacyComposerDocument = (input: BuildSessionMessagePayloadInput): ComposerDocument => {
  const nodes: ComposerNode[] = [];
  if (input.text) nodes.push({ id: "legacy-text", type: "text", text: input.text });
  const append = (node: ComposerNode) => {
    if (nodes.length > 0) nodes.push({ id: `legacy-separator-${nodes.length}`, type: "text", text: "\n" });
    nodes.push(node);
  };
  input.pendingFiles.forEach((file) => append({ ...file, type: "snippet" }));
  input.pendingPathAttachments.forEach((attachment) => append({ ...attachment, type: "path" }));
  input.sessionReferences.forEach((reference, index) => append({
    id: `legacy-session-${index}-${reference.sourceSessionId}`,
    type: "session",
    reference: { ...reference },
  }));
  return createComposerDocument(nodes);
};

export type BuildSessionMessagePayloadInput = {
  text: string;
  images: QueuedMessageImage[];
  pendingFiles: PendingFile[];
  pendingPathAttachments: PendingPathAttachment[];
  sessionReferences: SessionReference[];
  document?: ComposerDocument;
  forkContext?: string;
  action?: AgentActionInvocation;
  readFile: (path: string) => Promise<{ success: boolean; content?: string; error?: string }>;
};

const isCompleteSessionReference = (
  reference: ComposerSessionReference,
): reference is ComposerSessionReference & SessionReference =>
  typeof reference.sourceSessionId === "string" &&
  typeof reference.sourceTitle === "string" &&
  typeof reference.sourceAgentId === "string" &&
  typeof reference.sourceUpdatedAt === "string" &&
  typeof reference.addedAt === "string" &&
  typeof reference.summary === "string";

export async function buildSessionMessagePayload(
  input: BuildSessionMessagePayloadInput,
): Promise<PreparedSessionMessage> {
  const sourceDocument = input.document
    ? cloneComposerDocument(input.document)
    : legacyComposerDocument(input);
  const legacyDocumentImages = getComposerImageNodes(sourceDocument);
  const document = withoutComposerImages(sourceDocument);
  const displayParts: string[] = [];
  const sendParts: string[] = [];
  const images: QueuedMessageImage[] = [];
  for (const image of [...input.images, ...legacyDocumentImages]) {
    if (!images.some((current) => current.id === image.id)) {
      images.push({ id: image.id, src: image.src, name: image.name, mimeType: image.mimeType });
    }
  }
  const files: PendingFile[] = [];
  const paths: PendingPathAttachment[] = [];
  const references: SessionReference[] = [];

  for (const node of document.nodes) {
    if (node.type === "text") {
      displayParts.push(node.text);
      sendParts.push(node.text);
      continue;
    }

    displayParts.push(getComposerNodeLabel(node));
    // New composers keep images outside the ordered document. This branch
    // only protects against a malformed or concurrently migrated document.
    if (node.type === "image") continue;
    if (node.type === "path") {
      paths.push({ id: node.id, name: node.name, path: node.path, kind: node.kind });
      sendParts.push(`<${node.kind} path="${escapeXmlAttribute(node.path)}" />`);
      continue;
    }

    if (node.type === "session") {
      if (isCompleteSessionReference(node.reference)) {
        const reference = { ...node.reference } as SessionReference;
        references.push(reference);
        sendParts.push(buildSessionReferencesContext([reference]));
      } else {
        sendParts.push(getComposerNodeLabel(node));
      }
      continue;
    }

    files.push({
      id: node.id,
      fileName: node.fileName,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
    });
    try {
      const result = await input.readFile(node.filePath);
      if (result.success && typeof result.content === "string") {
        const selectedLines = result.content.split("\n").slice(node.startLine - 1, node.endLine);
        sendParts.push(`<file path="${escapeXmlAttribute(node.filePath)}" lines="${node.startLine}-${node.endLine}">\n${selectedLines.join("\n")}\n</file>`);
      } else {
        sendParts.push(`[无法读取文件: ${node.fileName}]`);
      }
    } catch {
      sendParts.push(`[无法读取文件: ${node.fileName}]`);
    }
  }

  images.forEach((image) => {
    sendParts.push(`<image_attachment name="${escapeXmlAttribute(image.name)}" />`);
  });

  let displayContent = displayParts.join("").trim();
  let sendContent = sendParts.join("").trim();
  if (input.forkContext) {
    sendContent = [input.forkContext, "", "<current_user_message>", sendContent, "</current_user_message>"].join("\n");
  }

  if (!displayContent && images.length > 0) displayContent = images.map((image) => `[image: ${image.name}]`).join(" ");
  const messageImages = images.length > 0
    ? images.map(({ id, src, name }) => ({ id, src, name }))
    : undefined;
  const agentImages = images.length > 0
    ? images.map((image) => ({
        type: "image" as const,
        data: image.src.includes(",") ? image.src.slice(image.src.indexOf(",") + 1) : image.src,
        mimeType: image.mimeType || "image/png",
      }))
    : undefined;
  const sessionReferences = references.length > 0
    ? references.map(({ sourceSessionId, sourceTitle }) => ({ sourceSessionId, sourceTitle }))
    : undefined;
  const editableText = input.document ? getComposerPlainText(document) : input.text;

  return {
    editableContent: editableText.trim(),
    displayContent,
    sendContent,
    messageImages,
    sessionReferences,
    agentImages,
    composerDocument: document,
    forkContextUsed: !!input.forkContext,
    action: input.action,
    editableDraft: {
      text: editableText,
      images,
      pendingFiles: files,
      pendingPathAttachments: paths,
      sessionReferences: references,
      document,
      forkContext: input.forkContext,
      action: input.action,
    },
  };
}
