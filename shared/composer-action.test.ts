import { describe, expect, it } from "vitest";
import { getComposerAction } from "./composer-action";

describe("getComposerAction", () => {
  it("counts pasted blocks as content even though their text is not in the composer string", () => {
    expect(getComposerAction({
      text: "",
      imageCount: 0,
      referenceCount: 0,
      running: false,
      documentHasContent: true,
    })).toBe("send");
  });

  it("keeps abort available when the only content flag is off", () => {
    expect(getComposerAction({
      text: "   ",
      imageCount: 0,
      referenceCount: 0,
      running: true,
      documentHasContent: false,
    })).toBe("abort");
  });

  it("stays none for an empty composer", () => {
    expect(getComposerAction({ text: "", imageCount: 0, referenceCount: 0, running: false })).toBe("none");
  });
});
