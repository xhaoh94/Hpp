export const COMPOSER_DOCUMENT_VERSION = 1 as const;

export type ComposerSessionReference = {
  sourceSessionId: string;
  sourceTitle: string;
  sourceAgentId?: string;
  sourceUpdatedAt?: string;
  addedAt?: string;
  summary?: string;
};

export type ComposerTextNode = {
  id: string;
  type: "text";
  text: string;
};

export type ComposerImageNode = {
  id: string;
  type: "image";
  name: string;
  src: string;
  mimeType: string;
};

export type ComposerPathNode = {
  id: string;
  type: "path";
  name: string;
  path: string;
  kind: "file" | "folder";
};

export type ComposerSnippetNode = {
  id: string;
  type: "snippet";
  fileName: string;
  filePath: string;
  startLine: number;
  endLine: number;
};

export type ComposerSessionNode = {
  id: string;
  type: "session";
  reference: ComposerSessionReference;
};

export type ComposerNode =
  | ComposerTextNode
  | ComposerImageNode
  | ComposerPathNode
  | ComposerSnippetNode
  | ComposerSessionNode;

export type ComposerDocument = {
  version: typeof COMPOSER_DOCUMENT_VERSION;
  nodes: ComposerNode[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;

export const createComposerDocument = (nodes: ComposerNode[] = []): ComposerDocument => ({
  version: COMPOSER_DOCUMENT_VERSION,
  nodes: normalizeComposerNodes(nodes),
});

export const cloneComposerDocument = (document: ComposerDocument): ComposerDocument => ({
  version: COMPOSER_DOCUMENT_VERSION,
  nodes: document.nodes.map((node) => node.type === "session"
    ? { ...node, reference: { ...node.reference } }
    : { ...node }),
});

export const getComposerImageNodes = (document: ComposerDocument) => document.nodes
  .filter((node): node is ComposerImageNode => node.type === "image")
  .map((node) => ({ ...node }));

export const withoutComposerImages = (document: ComposerDocument): ComposerDocument =>
  createComposerDocument(document.nodes.filter((node) => node.type !== "image"));

export function normalizeComposerNodes(nodes: ComposerNode[]): ComposerNode[] {
  const normalized: ComposerNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (!node.text) continue;
      const previous = normalized.at(-1);
      if (previous?.type === "text") {
        previous.text += node.text;
      } else {
        normalized.push({ ...node });
      }
      continue;
    }
    normalized.push(node.type === "session"
      ? { ...node, reference: { ...node.reference } }
      : { ...node });
  }
  return normalized;
}

function fallbackNode(value: Record<string, unknown>, index: number): ComposerTextNode {
  const label = stringValue(value.name) || stringValue(value.label) || stringValue(value.type) || "未知引用";
  return { id: stringValue(value.id) || `legacy-unknown-${index}`, type: "text", text: `[${label}]` };
}

function parseNode(value: unknown, index: number): ComposerNode | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id) || `legacy-node-${index}`;
  if (value.type === "text") {
    const text = stringValue(value.text);
    return text === undefined ? fallbackNode(value, index) : { id, type: "text", text };
  }
  if (value.type === "image") {
    const name = stringValue(value.name);
    const src = stringValue(value.src);
    const mimeType = stringValue(value.mimeType);
    return name && src?.startsWith("data:image/") && mimeType?.startsWith("image/")
      ? { id, type: "image", name, src, mimeType }
      : fallbackNode(value, index);
  }
  if (value.type === "path") {
    const name = stringValue(value.name);
    const path = stringValue(value.path);
    const kind = value.kind === "file" || value.kind === "folder" ? value.kind : undefined;
    return name && path && kind ? { id, type: "path", name, path, kind } : fallbackNode(value, index);
  }
  if (value.type === "snippet") {
    const fileName = stringValue(value.fileName);
    const filePath = stringValue(value.filePath);
    const startLine = Number.isInteger(value.startLine) ? value.startLine as number : 0;
    const endLine = Number.isInteger(value.endLine) ? value.endLine as number : 0;
    return fileName && filePath && startLine > 0 && endLine >= startLine
      ? { id, type: "snippet", fileName, filePath, startLine, endLine }
      : fallbackNode(value, index);
  }
  if (value.type === "session" && isRecord(value.reference)) {
    const sourceSessionId = stringValue(value.reference.sourceSessionId);
    const sourceTitle = stringValue(value.reference.sourceTitle);
    if (!sourceSessionId || !sourceTitle) return fallbackNode(value, index);
    const reference: ComposerSessionReference = { sourceSessionId, sourceTitle };
    for (const key of ["sourceAgentId", "sourceUpdatedAt", "addedAt", "summary"] as const) {
      const field = stringValue(value.reference[key]);
      if (field !== undefined) reference[key] = field;
    }
    return { id, type: "session", reference };
  }
  return fallbackNode(value, index);
}

export function parseComposerDocument(value: unknown): ComposerDocument | undefined {
  if (!isRecord(value) || value.version !== COMPOSER_DOCUMENT_VERSION || !Array.isArray(value.nodes)) return undefined;
  return createComposerDocument(value.nodes
    .map(parseNode)
    .filter((node): node is ComposerNode => !!node));
}

export const getComposerPlainText = (document: ComposerDocument) => document.nodes
  .filter((node): node is ComposerTextNode => node.type === "text")
  .map((node) => node.text)
  .join("");

export const composerDocumentHasContent = (document: ComposerDocument) =>
  document.nodes.some((node) => node.type === "text" ? !!node.text.trim() : true);

export const getComposerNodeLabel = (node: Exclude<ComposerNode, ComposerTextNode>) => {
  if (node.type === "image") return `[image: ${node.name}]`;
  if (node.type === "path") return `[${node.kind}: ${node.name}]`;
  if (node.type === "snippet") return `[${node.fileName}:${node.startLine}-${node.endLine}]`;
  return `[引用会话: ${node.reference.sourceTitle}]`;
};
