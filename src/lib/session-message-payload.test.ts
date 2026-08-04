import { describe, expect, it, vi } from "vitest";
import { buildSessionMessagePayload } from "./session-message-payload";
import { createComposerDocument } from "@shared/composer-document";

describe("session message payload", () => {
  it("rebuilds text, images, files, paths, references and actions from an editable draft", async () => {
    const readFile = vi.fn().mockResolvedValue({ success: true, content: "one\ntwo\nthree" });
    const payload = await buildSessionMessagePayload({
      text: "run this",
      images: [{ id: "image-1", name: "screen.png", src: "data:image/png;base64,YWJj", mimeType: "image/png" }],
      pendingFiles: [{ id: "snippet-1", fileName: "main.ts", filePath: "C:\\repo\\main.ts", startLine: 2, endLine: 3 }],
      pendingPathAttachments: [{ id: "folder-1", name: "src", path: "C:\\repo\\src", kind: "folder" }],
      sessionReferences: [{
        sourceSessionId: "session-2",
        sourceAgentId: "codex",
        sourceTitle: "Earlier work",
        sourceUpdatedAt: "2026-01-01",
        addedAt: "2026-01-01",
        summary: "Previous context",
      }],
      forkContext: "<fork_context>source</fork_context>",
      action: { kind: "skill", name: "review" },
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith("C:\\repo\\main.ts");
    expect(payload.displayContent).toContain("run this\n[main.ts:2-3]\n[folder: src]");
    expect(payload.sendContent).toContain('<file path="C:\\repo\\main.ts" lines="2-3">\ntwo\nthree\n</file>');
    expect(payload.sendContent).toContain('<folder path="C:\\repo\\src" />');
    expect(payload.sendContent).toContain("<current_user_message>");
    expect(payload.agentImages).toEqual([{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    expect(payload.sessionReferences).toEqual([{ sourceSessionId: "session-2", sourceTitle: "Earlier work" }]);
    expect(payload.editableDraft).toMatchObject({
      text: "run this",
      action: { kind: "skill", name: "review" },
      forkContext: "<fork_context>source</fork_context>",
    });
  });

  it("keeps ordered references inline while migrating images to independent attachments", async () => {
    const payload = await buildSessionMessagePayload({
      text: "ignored legacy text",
      images: [],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      document: createComposerDocument([
        { id: "t1", type: "text", text: "before" },
        { id: "p1", type: "path", name: "src", path: "C:\\repo\\src", kind: "folder" },
        { id: "t2", type: "text", text: "middle" },
        { id: "i1", type: "image", name: "screen.png", src: "data:image/png;base64,YWJj", mimeType: "image/png" },
        { id: "t3", type: "text", text: "after" },
      ]),
      readFile: async () => ({ success: true, content: "" }),
    });
    expect(payload.displayContent.indexOf("before")).toBeLessThan(payload.displayContent.indexOf("[folder: src]"));
    expect(payload.displayContent.indexOf("[folder: src]")).toBeLessThan(payload.displayContent.indexOf("middle"));
    expect(payload.displayContent).not.toContain("[image: screen.png]");
    expect(payload.displayContent).toContain("middleafter");
    expect(payload.sendContent.indexOf("before")).toBeLessThan(payload.sendContent.indexOf("<folder path="));
    expect(payload.sendContent.indexOf("<folder path=")).toBeLessThan(payload.sendContent.indexOf("middle"));
    expect(payload.sendContent.indexOf("after")).toBeLessThan(payload.sendContent.indexOf("<image_attachment"));
    expect(payload.messageImages).toEqual([{ id: "i1", src: "data:image/png;base64,YWJj", name: "screen.png" }]);
    expect(payload.editableDraft?.document?.nodes.map((node) => node.type)).toEqual(["text", "path", "text"]);
    expect(payload.editableDraft?.images).toHaveLength(1);
  });
});
