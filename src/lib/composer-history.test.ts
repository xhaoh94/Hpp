import { describe, expect, it } from "vitest";
import type { ChatDraft, ChatMessage, QueuedMessageEditableDraft } from "@/stores/chat-store";
import {
  ComposerHistoryController,
  createComposerDraftSnapshot,
  draftFromMessage,
  parseComposerDraftSnapshot,
} from "./composer-history";

const reference = {
  sourceSessionId: "referenced",
  sourceAgentId: "codex",
  sourceTitle: "Referenced session",
  sourceUpdatedAt: "2026-07-20T00:00:00.000Z",
  addedAt: "2026-07-20T00:00:00.000Z",
  summary: "Context",
};

const fullDraft = (text: string): ChatDraft => ({
  text,
  pendingImages: [{
    id: "image-1",
    src: "data:image/png;base64,YWJj",
    name: "screen.png",
    file: { name: "screen.png", type: "image/png", size: 0 } as File,
  }],
  pendingFiles: [{ id: "snippet-1", fileName: "main.ts", filePath: "C:\\repo\\main.ts", startLine: 2, endLine: 4 }],
  pendingPathAttachments: [{ id: "folder-1", name: "src", path: "C:\\repo\\src", kind: "folder" }],
  sessionReferences: [reference],
  action: { kind: "skill", name: "review" },
});

const message = (id: string, text: string, draft?: QueuedMessageEditableDraft): ChatMessage => ({
  id,
  role: "user",
  content: text,
  timestamp: 1,
  composerDraft: createComposerDraftSnapshot(draft),
});

const editableDraft = (text: string): QueuedMessageEditableDraft => ({
  text,
  images: [{ id: "image-1", src: "data:image/png;base64,YWJj", name: "screen.png", mimeType: "image/png" }],
  pendingFiles: [{ id: "snippet-1", fileName: "main.ts", filePath: "C:\\repo\\main.ts", startLine: 2, endLine: 4 }],
  pendingPathAttachments: [{ id: "folder-1", name: "src", path: "C:\\repo\\src", kind: "folder" }],
  sessionReferences: [reference],
  forkContext: "must not persist",
  action: { kind: "skill", name: "review" },
});

describe("composer draft snapshots", () => {
  it("persists every editable field except transient fork context", () => {
    const snapshot = createComposerDraftSnapshot(editableDraft("  raw text  "));
    expect(snapshot).toMatchObject({
      text: "  raw text  ",
      images: [{ mimeType: "image/png" }],
      pendingFiles: [{ filePath: "C:\\repo\\main.ts" }],
      pendingPathAttachments: [{ path: "C:\\repo\\src" }],
      sessionReferences: [reference],
      action: { kind: "skill", name: "review" },
    });
    expect(snapshot).not.toHaveProperty("forkContext");
    expect(draftFromMessage(message("one", "display", editableDraft("raw")))).toMatchObject({
      text: "raw",
      pendingImages: [{ name: "screen.png" }],
      pendingFiles: [{ filePath: "C:\\repo\\main.ts" }],
      pendingPathAttachments: [{ kind: "folder" }],
      sessionReferences: [reference],
      action: { kind: "skill", name: "review" },
    });
  });

  it("filters damaged members and rejects malformed snapshot roots", () => {
    expect(parseComposerDraftSnapshot({ text: "missing arrays" })).toBeUndefined();
    expect(parseComposerDraftSnapshot({
      text: "valid",
      images: [null, { id: "good", src: "data:image/png;base64,YQ==", name: "a.png", mimeType: "image/png" }],
      pendingFiles: [{ id: "bad", fileName: "a", filePath: "x", startLine: 4, endLine: 2 }],
      pendingPathAttachments: [{ id: "bad", name: "x", path: "x", kind: "other" }],
      sessionReferences: [{ sourceSessionId: "incomplete" }],
    })).toEqual({
      text: "valid",
      images: [{ id: "good", src: "data:image/png;base64,YQ==", name: "a.png", mimeType: "image/png" }],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      action: undefined,
    });
  });

  it("uses display text and resolvable metadata for legacy messages", () => {
    const legacy: ChatMessage = {
      id: "legacy",
      role: "user",
      content: "old text\n[file: unavailable.txt]",
      timestamp: 1,
      images: [{ id: "old-image", src: "data:image/jpeg;base64,YQ==", name: "old.jpg" }],
      sessionReferences: [{ sourceSessionId: "referenced", sourceTitle: "Old reference" }],
      action: { kind: "command", name: "test" },
    };
    const draft = draftFromMessage(legacy, () => reference);
    expect(draft.text).toBe(legacy.content);
    expect(draft.pendingFiles).toEqual([]);
    expect(draft.pendingImages[0].file.type).toBe("image/jpeg");
    expect(draft.sessionReferences).toEqual([reference]);
    expect(draft.action).toEqual({ kind: "command", name: "test" });
  });
});

describe("composer history controller", () => {
  it("preserves temporary edits and restores the original current draft", () => {
    const controller = new ComposerHistoryController();
    const messages = [
      message("first", "first"),
      message("second", "display second", editableDraft("second")),
    ];
    const current = fullDraft("current draft");

    const second = controller.previous("session-one", current, messages)!;
    expect(second.text).toBe("second");
    second.text = "edited second";
    const first = controller.previous("session-one", second, messages)!;
    expect(first.text).toBe("first");
    expect(controller.previous("session-one", first, messages)).toBeNull();
    expect(controller.next("session-one", first)?.text).toBe("edited second");
    const restored = controller.next("session-one", fullDraft("edited second"))!;
    expect(restored.text).toBe("current draft");
    expect(restored.pendingFiles).toEqual(current.pendingFiles);
  });

  it("isolates sessions and resets only the sent session", () => {
    const controller = new ComposerHistoryController();
    expect(controller.previous("one", fullDraft("draft one"), [message("one-msg", "one")])?.text).toBe("one");
    expect(controller.previous("two", fullDraft("draft two"), [message("two-msg", "two")])?.text).toBe("two");
    controller.reset("one");
    expect(controller.next("one", fullDraft("one"))).toBeNull();
    expect(controller.next("two", fullDraft("two"))?.text).toBe("draft two");
  });
});
