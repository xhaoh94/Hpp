import { describe, expect, it } from "vitest";
import { partitionPastedFiles, readClipboardFiles } from "./paste-attachments";

describe("pasted attachments", () => {
  it("splits pasted files into images and other files", () => {
    const video = { type: "video/mp4", name: "clip.mp4" };
    const image = { type: "image/png", name: "shot.png" };
    const folder = { type: "", name: "" };
    const result = partitionPastedFiles(
      [video, image, folder],
      (file) => file.type.startsWith("image/"),
    );
    expect(result.imageFiles).toEqual([image]);
    // 视频和文件夹都走路径附件，而不是被当成图片或直接丢弃。
    expect(result.otherFiles).toEqual([video, folder]);
  });

  it("reads file items only, ignoring text items", () => {
    const videoFile = { name: "clip.mp4" } as File;
    const textFile = { name: "notes.txt" } as File;
    const items = [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => videoFile },
      { kind: "file", getAsFile: () => null },
      { kind: "file", getAsFile: () => textFile },
    ];
    expect(readClipboardFiles(items)).toEqual([videoFile, textFile]);
  });

  it("returns no files when the clipboard only has text", () => {
    expect(readClipboardFiles([{ kind: "string", getAsFile: () => null }])).toEqual([]);
  });
});
