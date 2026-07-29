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
