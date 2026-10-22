import { describe, expect, it } from "vitest";
import { isVideoAttachment, toLocalMediaUrl } from "./media-preview";

describe("local media preview", () => {
  it("builds a stream url from the local media server prefix", () => {
    const base = "http://127.0.0.1:12345/media/token/";
    // 整个路径作为一个参数编码，服务端 decode 后校验绝对路径。
    expect(toLocalMediaUrl("C:/repo/clip.mp4", base)).toBe(`${base}C%3A%2Frepo%2Fclip.mp4`);
    expect(toLocalMediaUrl("/home/a/clip.mp4", base)).toBe(`${base}%2Fhome%2Fa%2Fclip.mp4`);
    expect(toLocalMediaUrl("", base)).toBe("");
    expect(toLocalMediaUrl("C:/a.mp4", "")).toBe("");
  });

  it("detects videos by mime type or file extension", () => {
    expect(isVideoAttachment({ type: "video/mp4", name: "clip" })).toBe(true);
    // 剪贴板里有时 MIME 是空的，只能看扩展名。
    expect(isVideoAttachment({ type: "", name: "clip.MOV" })).toBe(true);
    expect(isVideoAttachment({ type: "", name: "clip.mkv" })).toBe(true);
    expect(isVideoAttachment({ type: "image/png", name: "shot.png" })).toBe(false);
    expect(isVideoAttachment({ type: "", name: "notes.txt" })).toBe(false);
  });
});
