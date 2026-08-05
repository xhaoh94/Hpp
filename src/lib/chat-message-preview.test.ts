import { describe, expect, it } from "vitest";
import { getChatMessagePreviewText } from "./chat-message-preview";

describe("getChatMessagePreviewText", () => {
  it("prefers user text over a leading ordered file reference", () => {
    expect(getChatMessagePreviewText({
      content: "[file: Electron_Wayland_niri_Rime_IME_issue_summary.md]帮我看下这个项目有没有类似问题",
      composerDocument: {
        version: 1,
        nodes: [
          {
            id: "file-1",
            type: "path",
            name: "Electron_Wayland_niri_Rime_IME_issue_summary.md",
            path: "C:/Downloads/Electron_Wayland_niri_Rime_IME_issue_summary.md",
            kind: "file",
          },
          { id: "text-1", type: "text", text: "帮我看下这个项目有没有类似问题" },
        ],
      },
    })).toBe("帮我看下这个项目有没有类似问题");
  });

  it("uses ordered reference labels when a message contains no text", () => {
    expect(getChatMessagePreviewText({
      content: "",
      composerDraft: {
        text: "",
        images: [],
        pendingFiles: [],
        pendingPathAttachments: [],
        sessionReferences: [],
        document: {
          version: 1,
          nodes: [{
            id: "folder-1",
            type: "path",
            name: "src",
            path: "C:/Project/Hpp/src",
            kind: "folder",
          }],
        },
      },
    })).toBe("[folder: src]");
  });

  it("extracts text from legacy attachment-prefixed content", () => {
    expect(getChatMessagePreviewText({
      content: "[file: long-name.md]\n  检查这个问题  ",
    })).toBe("检查这个问题");
  });
});
