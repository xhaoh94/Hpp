export type ComposerAction = "none" | "send" | "abort";

export interface ComposerActionInput {
  text: string;
  composingText?: string;
  imageCount: number;
  fileCount?: number;
  pathAttachmentCount?: number;
  referenceCount: number;
  actionCount?: number;
  running: boolean;
}

export function getComposerAction(input: ComposerActionInput): ComposerAction {
  const hasContent = input.text.trim().length > 0
    || (input.composingText?.trim().length || 0) > 0
    || input.imageCount > 0
    || (input.fileCount || 0) > 0
    || (input.pathAttachmentCount || 0) > 0
    || input.referenceCount > 0
    || (input.actionCount || 0) > 0;
  if (input.running && !hasContent) return "abort";
  return hasContent ? "send" : "none";
}
