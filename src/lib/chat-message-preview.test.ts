import { describe, expect, it } from "vitest";
import {
  getChatMessagePreviewText,
  getSessionPreviewLabel,
  sanitizeSessionPreview,
} from "./chat-message-preview";

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

  it("自闭合 file 标签只显示文件名", () => {
    expect(getChatMessagePreviewText({
      content: `<file path="G:\\Work\\Projects\\Pro2\\dev\\Assets\\Lua\\Logic\\MainUI\\WndMainBottom.lua" />`,
    })).toBe("[file: WndMainBottom.lua]");
  });

  it("自闭合 file 标签支持单引号路径", () => {
    expect(getChatMessagePreviewText({
      content: `<file path='C:\\repo\\src\\main.ts' />`,
    })).toBe("[file: main.ts]");
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

  it("只有图片、没有文字时显示 [图片] 而不是空", () => {
    expect(getChatMessagePreviewText({
      content: "",
      images: [{ id: "img-1", src: "data:image/png;base64,AAAA", name: "shot.png" }],
    })).toBe("[图片]");
  });

  it("多张图片带上数量", () => {
    expect(getChatMessagePreviewText({
      content: "",
      images: [
        { id: "img-1", src: "data:image/png;base64,AAAA", name: "a.png" },
        { id: "img-2", src: "data:image/png;base64,BBBB", name: "b.png" },
      ],
    })).toBe("[图片 × 2]");
  });

  it("composerDocument 只有图片节点时也显示 [图片]", () => {
    expect(getChatMessagePreviewText({
      content: "",
      composerDocument: {
        version: 1,
        nodes: [{ id: "img-1", type: "image", name: "shot.png", src: "data:image/png;base64,AAAA", mimeType: "image/png" }],
      },
    })).toBe("[图片]");
  });

  it("图片 + 文字时仍然以文字为标题", () => {
    expect(getChatMessagePreviewText({
      content: "看看这个报错",
      images: [{ id: "img-1", src: "data:image/png;base64,AAAA", name: "shot.png" }],
    })).toBe("看看这个报错");
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

/**
 * 回归：旧版本落盘的 preview 直接存了裸 content（未清洗），侧栏在会话正文
 * 尚未加载时会直接用它，因此读回时必须兜底清洗。
 */
describe("持久化 preview 的兜底清洗", () => {
  it("自闭合 file 标签的旧 preview 被规范为文件名", () => {
    expect(sanitizeSessionPreview(
      `<file path="G:\\Work\\Projects\\Pro2\\dev\\Assets\\Lua\\Logic\\MainUI\\WndMainBottom.lua" /> 底下的特殊按钮切营地`,
    )).toBe("[file: WndMainBottom.lua] 底下的特殊按钮切营地");
  });

  it("成对 file 标签与包裹标签一并清洗", () => {
    expect(sanitizeSessionPreview(
      `<current_user_message>\n<file path="C:\\repo\\main.ts" lines="1-3">\nx\n</file>\n看一下\n</current_user_message>`,
    )).toBe("[file: main.ts:1-3] 看一下");
  });

  it("已经干净的 preview 保持不变", () => {
    expect(sanitizeSessionPreview("普通的一段话")).toBe("普通的一段话");
  });
});

/**
 * 标题类位置（标题栏 / 页签 / 历史会话列表）用短标签列出具体附件名，
 * 聊天正文与发言记录仍用 getChatMessagePreviewText 的既有写法。
 */
describe("getSessionPreviewLabel", () => {
  it("只有图片时列出图片名，而不是笼统的 [图片]", () => {
    expect(getSessionPreviewLabel({
      content: "",
      images: [{ id: "img-1", src: "data:image/png;base64,AAAA", name: "shot.png" }],
    })).toBe("[shot.png]");
  });

  it("多张图片并列，超过 4 个用省略号", () => {
    expect(getSessionPreviewLabel({
      content: "",
      images: [
        { id: "1", src: "data:,", name: "a.png" },
        { id: "2", src: "data:,", name: "b.png" },
      ],
    })).toBe("[a.png][b.png]");

    expect(getSessionPreviewLabel({
      content: "",
      images: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, src: "data:,", name: `p${i}.png` })),
    })).toBe("[p0.png][p1.png][p2.png][p3.png]…");
  });

  it("文件与文件夹用各自的短标签", () => {
    expect(getSessionPreviewLabel({
      content: "",
      composerDocument: {
        version: 1,
        nodes: [
          { id: "f-1", type: "path", name: "a.ts", path: "C:/p/a.ts", kind: "file" },
          { id: "d-1", type: "path", name: "src", path: "C:/p/src", kind: "folder" },
          { id: "s-1", type: "snippet", fileName: "b.ts", filePath: "C:/p/b.ts", startLine: 3, endLine: 9 },
        ],
      },
    })).toBe("[a.ts][src][b.ts:3-9]");
  });

  it("有文字时仍然以文字为准", () => {
    expect(getSessionPreviewLabel({
      content: "修一下这个报错",
      images: [{ id: "img-1", src: "data:,", name: "shot.png" }],
    })).toBe("修一下这个报错");
  });

  it("聊天内预览保持原有写法，不受标题格式影响", () => {
    expect(getChatMessagePreviewText({
      content: "",
      images: [{ id: "img-1", src: "data:,", name: "shot.png" }],
    })).toBe("[图片]");
  });
});

describe("getSessionPreviewLabel maxLabels", () => {
  it("会话标题只取第一个附件名", () => {
    expect(getSessionPreviewLabel({
      content: "",
      images: [
        { id: "1", src: "data:,", name: "a.png" },
        { id: "2", src: "data:,", name: "b.png" },
      ],
    }, { maxLabels: 1 })).toBe("[a.png]");

    expect(getSessionPreviewLabel({
      content: "",
      composerDocument: {
        version: 1,
        nodes: [
          { id: "i", type: "image", name: "shot.png", src: "data:,", mimeType: "image/png" },
          { id: "f", type: "path", name: "a.ts", path: "C:/p/a.ts", kind: "file" },
        ],
      },
    }, { maxLabels: 1 })).toBe("[shot.png]");
  });

  it("有文字时不受 maxLabels 影响", () => {
    expect(getSessionPreviewLabel({
      content: "看看这个报错",
      images: [{ id: "1", src: "data:,", name: "a.png" }],
    }, { maxLabels: 1 })).toBe("看看这个报错");
  });
});

describe("粘贴块在会话标题/列表里的预览", () => {
  const pasted = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");

  it("describes the paste by size instead of dumping its text", () => {
    const message = {
      content: "",
      composerDocument: {
        version: 1 as const,
        nodes: [{ id: "p1", type: "paste" as const, text: pasted }],
      },
    };

    expect(getChatMessagePreviewText(message)).toBe("[粘贴文本: 80 行]");
    expect(getSessionPreviewLabel(message)).toBe("[粘贴文本: 80 行]");
  });

  it("still prefers hand-written text when the message has both", () => {
    const message = {
      content: "",
      composerDocument: {
        version: 1 as const,
        nodes: [
          { id: "t1", type: "text" as const, text: "看看这段" },
          { id: "p1", type: "paste" as const, text: pasted },
        ],
      },
    };

    expect(getChatMessagePreviewText(message)).toBe("看看这段");
  });
});
