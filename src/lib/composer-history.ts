import {
  cloneChatDraft,
  createEmptyChatDraft,
  type ChatDraft,
  type ChatMessage,
  type ComposerDraftSnapshot,
  type PendingImage,
  type PendingPathAttachment,
  type QueuedMessageEditableDraft,
} from "@/stores/chat-store";
import type { SessionReference } from "@/stores/project-store";
import type { AgentActionInvocation } from "@shared/agent-actions";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const getString = (value: unknown) => typeof value === "string" ? value : undefined;

const parseAction = (value: unknown): AgentActionInvocation | undefined => {
  if (!isRecord(value) || (value.kind !== "skill" && value.kind !== "command")) return undefined;
  const name = getString(value.name)?.trim();
  return name ? { kind: value.kind, name } : undefined;
};

const parseImage = (value: unknown) => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const src = getString(value.src);
  const name = getString(value.name);
  const mimeType = getString(value.mimeType);
  if (!id || !src?.startsWith("data:image/") || !name || !mimeType?.startsWith("image/")) return null;
  return { id, src, name, mimeType };
};

const parsePendingFile = (value: unknown) => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const fileName = getString(value.fileName);
  const filePath = getString(value.filePath);
  const startLine = typeof value.startLine === "number" && Number.isInteger(value.startLine) ? value.startLine : undefined;
  const endLine = typeof value.endLine === "number" && Number.isInteger(value.endLine) ? value.endLine : undefined;
  if (!id || !fileName || !filePath || !startLine || !endLine || startLine < 1 || endLine < startLine) return null;
  return { id, fileName, filePath, startLine, endLine };
};

const parsePathAttachment = (value: unknown): PendingPathAttachment | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id);
  const name = getString(value.name);
  const path = getString(value.path);
  const kind: PendingPathAttachment["kind"] | undefined =
    value.kind === "file" || value.kind === "folder" ? value.kind : undefined;
  if (!id || !name || !path || !kind) return null;
  return { id, name, path, kind };
};

const parseSessionReference = (value: unknown): SessionReference | null => {
  if (!isRecord(value)) return null;
  const sourceSessionId = getString(value.sourceSessionId);
  const sourceAgentId = getString(value.sourceAgentId);
  const sourceTitle = getString(value.sourceTitle);
  const sourceUpdatedAt = getString(value.sourceUpdatedAt);
  const addedAt = getString(value.addedAt);
  const summary = getString(value.summary);
  if (!sourceSessionId || !sourceAgentId || !sourceTitle || !sourceUpdatedAt || !addedAt || summary === undefined) return null;
  return { sourceSessionId, sourceAgentId, sourceTitle, sourceUpdatedAt, addedAt, summary };
};

export function parseComposerDraftSnapshot(value: unknown): ComposerDraftSnapshot | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  if (
    !Array.isArray(value.images) ||
    !Array.isArray(value.pendingFiles) ||
    !Array.isArray(value.pendingPathAttachments) ||
    !Array.isArray(value.sessionReferences)
  ) return undefined;

  const action = value.action === undefined ? undefined : parseAction(value.action);
  if (value.action !== undefined && !action) return undefined;
  return {
    text: value.text,
    images: value.images.map(parseImage).filter((item): item is NonNullable<typeof item> => !!item),
    pendingFiles: value.pendingFiles.map(parsePendingFile).filter((item): item is NonNullable<typeof item> => !!item),
    pendingPathAttachments: value.pendingPathAttachments
      .map(parsePathAttachment)
      .filter((item): item is NonNullable<typeof item> => !!item),
    sessionReferences: value.sessionReferences
      .map(parseSessionReference)
      .filter((item): item is SessionReference => !!item),
    action,
  };
}

export function createComposerDraftSnapshot(
  draft?: QueuedMessageEditableDraft,
): ComposerDraftSnapshot | undefined {
  if (!draft) return undefined;
  return {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
    pendingFiles: draft.pendingFiles.map((file) => ({ ...file })),
    pendingPathAttachments: draft.pendingPathAttachments.map((attachment) => ({ ...attachment })),
    sessionReferences: draft.sessionReferences.map((reference) => ({ ...reference })),
    action: draft.action ? { ...draft.action } : undefined,
  };
}

const inferImageMimeType = (src: string) =>
  /^data:([^;,]+)[;,]/.exec(src)?.[1] || "image/png";

const createRestoredFile = (name: string, mimeType: string): File => {
  if (typeof File === "function") return new File([], name, { type: mimeType });
  return { name, type: mimeType, size: 0 } as File;
};

const restoreImages = (
  images: Array<{ id: string; src: string; name: string; mimeType?: string }>,
): PendingImage[] => images.map((image) => {
  const mimeType = image.mimeType || inferImageMimeType(image.src);
  return {
    id: image.id,
    src: image.src,
    name: image.name,
    file: createRestoredFile(image.name, mimeType),
  };
});

export function draftFromSnapshot(snapshot: ComposerDraftSnapshot): ChatDraft {
  return {
    text: snapshot.text,
    pendingImages: restoreImages(snapshot.images),
    pendingFiles: snapshot.pendingFiles.map((file) => ({ ...file })),
    pendingPathAttachments: snapshot.pendingPathAttachments.map((attachment) => ({ ...attachment })),
    sessionReferences: snapshot.sessionReferences.map((reference) => ({ ...reference })),
    action: snapshot.action ? { ...snapshot.action } : undefined,
  };
}

export type LegacyReferenceResolver = (
  reference: NonNullable<ChatMessage["sessionReferences"]>[number],
) => SessionReference | undefined;

export function draftFromMessage(
  message: ChatMessage,
  resolveLegacyReference?: LegacyReferenceResolver,
): ChatDraft {
  if (message.composerDraft) return draftFromSnapshot(message.composerDraft);
  const draft = createEmptyChatDraft();
  draft.text = message.content;
  draft.pendingImages = restoreImages(message.images || []);
  draft.sessionReferences = (message.sessionReferences || [])
    .map((reference) => resolveLegacyReference?.(reference))
    .filter((reference): reference is SessionReference => !!reference);
  draft.action = message.action ? { ...message.action } : undefined;
  return draft;
}

type HistoryState = {
  entries: ChatDraft[];
  index: number;
};

export class ComposerHistoryController {
  private readonly sessions = new Map<string, HistoryState>();

  previous(
    sessionId: string,
    currentDraft: ChatDraft,
    messages: ChatMessage[],
    resolveLegacyReference?: LegacyReferenceResolver,
  ): ChatDraft | null {
    let state = this.sessions.get(sessionId);
    if (!state) {
      const entries = messages
        .filter((message) => message.role === "user")
        .map((message) => draftFromMessage(message, resolveLegacyReference));
      entries.push(cloneChatDraft(currentDraft));
      state = { entries, index: entries.length - 1 };
      this.sessions.set(sessionId, state);
    }

    state.entries[state.index] = cloneChatDraft(currentDraft);
    if (state.index === 0) return null;
    state.index -= 1;
    return cloneChatDraft(state.entries[state.index]);
  }

  next(sessionId: string, currentDraft: ChatDraft): ChatDraft | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    state.entries[state.index] = cloneChatDraft(currentDraft);
    if (state.index >= state.entries.length - 1) return null;
    state.index += 1;
    return cloneChatDraft(state.entries[state.index]);
  }

  reset(sessionId: string) {
    this.sessions.delete(sessionId);
  }
}
