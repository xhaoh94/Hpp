import { describe, expect, it } from "vitest";
import { getComposerAction } from "./composer";

describe("mobile composer action", () => {
  it("sends text read directly from the textarea", () => {
    expect(getComposerAction({ text: "Android IME text", imageCount: 0, referenceCount: 0, running: false }))
      .toBe("send");
  });

  it("does nothing for an empty idle composer", () => {
    expect(getComposerAction({ text: "   ", imageCount: 0, referenceCount: 0, running: false }))
      .toBe("none");
  });

  it("enables send while an Android IME is still composing visible text", () => {
    expect(getComposerAction({
      text: "",
      composingText: "正在输入",
      imageCount: 0,
      referenceCount: 0,
      running: false,
    })).toBe("send");
  });

  it("aborts an active task only when the actual composer is empty", () => {
    expect(getComposerAction({ text: "", imageCount: 0, referenceCount: 0, running: true }))
      .toBe("abort");
    expect(getComposerAction({ text: "follow up", imageCount: 0, referenceCount: 0, running: true }))
      .toBe("send");
  });

  it("sends image-only and reference-only messages", () => {
    expect(getComposerAction({ text: "", imageCount: 1, referenceCount: 0, running: false }))
      .toBe("send");
    expect(getComposerAction({ text: "", imageCount: 0, referenceCount: 1, running: false }))
      .toBe("send");
  });
});
