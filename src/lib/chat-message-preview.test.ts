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
            path: "C:\\Downloads/Electron_Wayland_niri_Rime_IME_issue_summary.md",
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
            path: "C:\\Project/Hpp/src",
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

/**
 * 回归：历史消息没有 composerDocument，预览会回退到裸 content，
 * 而裸 content 里有发给 agent 的内部 XML 标签 —— 会话项上直接露出
 * `<file path="G:\\Work/...`。这里钉住「提取不到路径就显示文件名」。
 */
describe("裸 content 里的内部标签清洗", () => {
  it("把带正文的 file 标签换成 [file: 文件名:起止行]", () => {
    expect(getChatMessagePreviewText({
      content: `<file path="G:\\Work\\Projects\\Pro2\\dev\\combat.lua" lines="10-42">\nlocal x = 1\n</file>`,
    })).toBe("[file: combat.lua:10-42]");
  });

  it("没有 lines 属性时只显示文件名", () => {
    expect(getChatMessagePreviewText({
      content: `<file path="G:\\Work\\sub\\a.ts">\ncode\n</file>`,
    })).toBe("[file: a.ts]");
  });

  it("正斜杠路径同样只取末段", () => {
    expect(getChatMessagePreviewText({
      content: `<file path="C:\\Users/me/project/src/main.ts" lines="1-3">\nx\n</file>`,
    })).toBe("[file: main.ts:1-3]");
  });

  it("只有文件、没有任何文本时也不返回空（正是截图里的情况）", () => {
    const preview = getChatMessagePreviewText({
      content: `<file path="G:\\Work\\Projects\\Pro2\\dev">\nsome content that is long enough\n</file>`,
    });
    expect(preview).toBe("[file: dev]");
    expect(preview).not.toContain("G:");
    expect(preview).not.toContain("<file");
  });

  it("文件标签 + 文本时只保留文本（与既有「文本优先」语义一致）", () => {
    expect(getChatMessagePreviewText({
      content: `看看这个文件\n<file path="G:\\Work\\a.ts" lines="1-5">\ncode\n</file>`,
    })).toBe("看看这个文件");
  });

  it("图片附件标签", () => {
    expect(getChatMessagePreviewText({
      content: `<image_attachment name="shot.png" />`,
    })).toBe("[image: shot.png]");
  });

  it("fork 的来源会话标签", () => {
    expect(getChatMessagePreviewText({
      content: `继续\n<source session_id="abc" title="上个会话" agent="pi" />`,
    })).toBe("继续 [引用会话: 上个会话]");
  });

  it("剥掉只包裹不携带信息的标签", () => {
    expect(getChatMessagePreviewText({
      content: `<current_user_message>\n修一下这个\n</current_user_message>`,
    })).toBe("修一下这个");
  });

  it("路径为空时仍保留行号，不整体丢弃该标签", () => {
    expect(getChatMessagePreviewText({ content: `<file path="" lines="1-2">\nx\n</file>` })).toBe("[file: :1-2]");
  });

  it("不改动普通文本", () => {
    expect(getChatMessagePreviewText({ content: "普通的一段话" })).toBe("普通的一段话");
  });

  it("标签里含引号或尖括号时不崩", () => {
    expect(() => getChatMessagePreviewText({
      content: `<file path='C:\\a"b>.ts' lines="1-2">\nx\n</file>`,
    })).not.toThrow();
  });

  it("file 标签没有闭合时不会被吃掉后面的文本", () => {
    expect(getChatMessagePreviewText({
      content: `<file path="G:\\a.ts">\n没闭合`,
    })).toContain("没闭合");
  });
});
