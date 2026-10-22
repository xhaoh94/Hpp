import { describe, expect, it } from "vitest";
import { extractUserMessageAttachments } from "./user-message-attachments";

describe("user message attachments", () => {
  it("extracts every supported text attachment and leaves the message body below them", () => {
    expect(extractUserMessageAttachments([
      "请检查这些内容",
      "[file: WndPartnerUpStar.lua] [folder: scripts]",
      "[main.ts:2-8]",
    ].join("\n"))).toEqual({
      text: "请检查这些内容",
      attachments: [
        { kind: "file", label: "WndPartnerUpStar.lua" },
        { kind: "folder", label: "scripts" },
        { kind: "file", label: "main.ts:2-8" },
      ],
    });
  });

  it("supports attachment-only messages without creating an empty body", () => {
    expect(extractUserMessageAttachments("[folder: src]")).toEqual({
      text: "",
      attachments: [{ kind: "folder", label: "src" }],
    });
  });

  it("keeps ordinary bracketed text intact", () => {
    expect(extractUserMessageAttachments("时间范围 [12:30-13] 不属于附件")).toEqual({
      text: "时间范围 [12:30-13] 不属于附件",
      attachments: [],
    });
  });
});

/**
 * 回归：历史消息可能只剩发送给 Agent 的裸 content（信封 XML），旧版本不区分
 * displayContent/sendContent，分叉与重发也会把 sendContent 写回正文。
 * 这类消息必须在渲染前变成附件芯片，不能在气泡里露出 XML。
 */
describe("裸 content 里的内部标签", () => {
  it("自闭合 folder 标签变成文件夹芯片而不是正文", () => {
    expect(extractUserMessageAttachments([
      "在真机没有适配刘海屏，另外给歌手标记一下 Vip SQ 这些标志，你可以看下旧项目的实现",
      '<folder path="C:\\Project\\EchoMusicMobile" />',
    ].join("\n"))).toEqual({
      text: "在真机没有适配刘海屏，另外给歌手标记一下 Vip SQ 这些标志，你可以看下旧项目的实现",
      attachments: [{ kind: "folder", label: "EchoMusicMobile" }],
    });
  });

  it("自闭合 file 标签变成文件芯片", () => {
    expect(extractUserMessageAttachments('<file path="G:\\Work\\src\\main.ts" />')).toEqual({
      text: "",
      attachments: [{ kind: "file", label: "main.ts" }],
    });
  });

  it("带正文的 file 标签保留起止行标签", () => {
    expect(extractUserMessageAttachments(`看下这段\n<file path="G:\\Work\\a.ts" lines="2-8">\ncode\n</file>`)).toEqual({
      text: "看下这段",
      attachments: [{ kind: "file", label: "a.ts:2-8" }],
    });
  });

  it("剥掉 fork 的包裹标签，不把标签名显示成正文", () => {
    expect(extractUserMessageAttachments([
      "<current_user_message>",
      "修一下这个问题",
      "</current_user_message>",
    ].join("\n"))).toEqual({
      text: "修一下这个问题",
      attachments: [],
    });
  });

  it("图片标签变成图片附件，来源会话标签保留为可读文本", () => {
    expect(extractUserMessageAttachments([
      '<image_attachment name="shot.png" />',
      '<source session_id="abc" title="上个会话" agent="pi" />',
    ].join("\n"))).toEqual({
      // 图片不再以 `[image: xxx]` 形式留在正文里；渲染侧优先显示缩略图，
      // 没有缩略图数据时才退回图片芯片。
      text: "[引用会话: 上个会话]",
      attachments: [{ kind: "image", label: "shot.png" }],
    });
  });

  it("展示形式的 image 标签同样被取出", () => {
    expect(extractUserMessageAttachments("看下这张图 [image: screenshot.png]")).toEqual({
      text: "看下这张图",
      attachments: [{ kind: "image", label: "screenshot.png" }],
    });
  });
});
