import { describe, expect, it, vi } from "vitest";
import { buildSessionMessagePayload } from "./session-message-payload";

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
});
