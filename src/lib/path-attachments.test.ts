import { describe, expect, it } from "vitest";
import { PATH_ATTACHMENT_DRAG_MIME, writePathAttachmentDragData } from "./path-attachments";

describe("path attachment drag data", () => {
  it("writes the shared attachment payload and plain-text fallback", () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      setData: (type: string, value: string) => values.set(type, value),
    } as unknown as DataTransfer;

    writePathAttachmentDragData(dataTransfer, {
      name: "src",
      path: "C:\\work\\src",
      kind: "folder",
    });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(JSON.parse(values.get(PATH_ATTACHMENT_DRAG_MIME) || "")).toEqual({
      name: "src",
      path: "C:\\work\\src",
      kind: "folder",
    });
    expect(values.get("text/plain")).toBe("C:\\work\\src");
  });
});
