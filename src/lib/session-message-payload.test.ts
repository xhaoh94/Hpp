import { describe, expect, it, vi } from "vitest";
import { buildSessionMessagePayload } from "./session-message-payload";
import { createComposerDocument } from "@shared/composer-document";

describe("session message payload", () => {
  it("rebuilds text, images, files, paths, references and actions from an editable draft", async () => {
    const readFile = vi.fn().mockResolvedValue({ success: true, content: "one\ntwo\nthree" });
    const payload = await buildSessionMessagePayload({
      text: "run this",
      images: [{ id: "image-1", name: "screen.png", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", mimeType: "image/png" }],
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
    expect(payload.agentImages).toEqual([{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", mimeType: "image/png" }]);
    expect(payload.sessionReferences).toEqual([{ sourceSessionId: "session-2", sourceTitle: "Earlier work" }]);
    expect(payload.editableDraft).toMatchObject({
      text: "run this",
      action: { kind: "skill", name: "review" },
      forkContext: "<fork_context>source</fork_context>",
    });
  });

  it("sends pasted videos as path references while keeping the video card", async () => {
    const document = createComposerDocument([
      { id: "text-1", type: "text", text: "看这个视频" },
      { id: "video-1", type: "video", name: "clip.mp4", path: "C:/repo/clip.mp4", mimeType: "video/mp4" },
    ]);
    const payload = await buildSessionMessagePayload({
      text: "",
      images: [],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      document,
      readFile: vi.fn(),
    });

    // 界面上仍是一张视频卡片（文档里保留 video 节点）。
    expect(payload.displayContent).toContain("[video: clip.mp4]");
    expect(payload.editableDraft?.document?.nodes).toContainEqual(
      expect.objectContaining({ type: "video", path: "C:/repo/clip.mp4" }),
    );
    // 发给 Agent 的仍然只是路径引用，不传视频二进制。
    expect(payload.sendContent).toContain('<file path="C:/repo/clip.mp4" />');
    expect(payload.agentImages).toBeUndefined();
  });

  it("turns draft pending videos into video cards and path references", async () => {
    const payload = await buildSessionMessagePayload({
      text: "看这个视频",
      images: [],
      pendingVideos: [{ id: "video-draft", name: "clip.mp4", path: "C:/repo/clip.mp4", mimeType: "video/mp4" }],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      readFile: vi.fn(),
    });

    // 草稿里的视频在上方预览条里；发送时注入 document，消息气泡里仍是一张卡片。
    expect(payload.displayContent).toContain("[video: clip.mp4]");
    expect(payload.editableDraft?.document?.nodes).toContainEqual(
      expect.objectContaining({ id: "video-draft", type: "video", path: "C:/repo/clip.mp4" }),
    );
    expect(payload.editableDraft?.pendingVideos).toEqual([
      expect.objectContaining({ id: "video-draft", path: "C:/repo/clip.mp4" }),
    ]);
    expect(payload.sendContent).toContain('<file path="C:/repo/clip.mp4" />');
  });

  // 回归：只发图片的消息不再往正文写 `[image: 名字]`，否则气泡里会出现一段
  // 不是用户输入的文字，且会被 Pi 会话快照带回历史。图片由 messageImages 渲染。
  it("keeps an image-only message body empty so the bubble only shows the image", async () => {
    const payload = await buildSessionMessagePayload({
      text: "",
      images: [{
        id: "image-only",
        name: "image.png",
        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
        mimeType: "image/png",
      }],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      readFile: vi.fn(),
    });

    expect(payload.displayContent).toBe("");
    expect(payload.displayContent).not.toContain("[image:");
    expect(payload.sendContent).toContain('<image_attachment name="image.png" />');
    expect(payload.messageImages).toHaveLength(1);
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
        { id: "i1", type: "image", name: "screen.png", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", mimeType: "image/png" },
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
    expect(payload.messageImages).toEqual([{ id: "i1", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", name: "screen.png" }]);
    expect(payload.editableDraft?.document?.nodes.map((node) => node.type)).toEqual(["text", "path", "text"]);
    expect(payload.editableDraft?.images).toHaveLength(1);
  });
});

/**
 * 回归：SVG/BMP 附件曾原样 base64 发给渠道，导致整次请求失败
 * （`failed to decode image config: unsupported format`）。渠道只支持
 * png/jpeg/webp/gif，其余格式必须在发送前拦掉。
 */
describe("渠道不支持的图片格式", () => {
  it("不把 SVG 附件作为图片发给模型，但仍在展示内容里保留占位", async () => {
    const payload = await buildSessionMessagePayload({
      text: "看下这个图标",
      images: [{
        id: "image-svg",
        name: "icon.svg",
        src: "data:image/svg+xml;base64,PHN2Zy8+",
        mimeType: "image/svg+xml",
      }],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      readFile: async () => ({ success: true, content: "" }),
    });

    expect(payload.agentImages).toEqual([]);
    expect(payload.messageImages).toEqual([
      { id: "image-svg", src: "data:image/svg+xml;base64,PHN2Zy8+", name: "icon.svg" },
    ]);
  });

  it("同时保留受支持的图片", async () => {
    const payload = await buildSessionMessagePayload({
      text: "两张图",
      images: [
        { id: "svg", name: "icon.svg", src: "data:image/svg+xml;base64,PHN2Zy8+", mimeType: "image/svg+xml" },
        { id: "png", name: "shot.png", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", mimeType: "image/png" },
      ],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      readFile: async () => ({ success: true, content: "" }),
    });

    expect(payload.agentImages).toEqual([{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", mimeType: "image/png" }]);
  });
});

/**
 * 回归：`icon.svg` 被改名成 `icon.png` 时，声明的 mimeType 是 image/png，
 * 但字节仍是 SVG —— 渠道会以 `You have uploaded an unsupported image` 拒绝
 * 整次请求。必须按真实字节判定。
 */
describe("声明格式与实际字节不一致", () => {
  it("头像声明 PNG 但实际是 SVG 时不发给模型", async () => {
    const svgAsPng = "data:image/png;base64," + Buffer.from("<?xml version=\"1.0\"?><svg/>").toString("base64");
    const payload = await buildSessionMessagePayload({
      text: "改成 app 图标",
      images: [{ id: "fake-png", name: "icon.png", src: svgAsPng, mimeType: "image/png" }],
      pendingFiles: [],
      pendingPathAttachments: [],
      sessionReferences: [],
      readFile: async () => ({ success: true, content: "" }),
    });

    expect(payload.agentImages).toEqual([]);
    expect(payload.messageImages).toHaveLength(1);
  });
});
