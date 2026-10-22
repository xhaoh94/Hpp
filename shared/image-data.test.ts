import { describe, expect, it } from "vitest";
import { detectImageMimeType, isProviderSafeImageDataUrl } from "./image-data";

const SVG_AS_PNG = "data:image/png;base64," + Buffer.from("<?xml version=\"1.0\"?><svg/>").toString("base64");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("图片真实格式识别", () => {
  it("识别渠道支持的四种格式", () => {
    expect(detectImageMimeType(PNG)).toBe("image/png");
    expect(detectImageMimeType("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==")).toBe("image/jpeg");
    expect(detectImageMimeType("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toBe("image/gif");
    expect(detectImageMimeType("data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAAAA==")).toBe("image/webp");
  });

  it("声明的 mimeType 与实际字节不一致时按字节判定", () => {
    // 典型的 `icon.svg` 改名成 `icon.png`：type/扩展名都说是 PNG。
    expect(detectImageMimeType(SVG_AS_PNG)).toBeUndefined();
    expect(isProviderSafeImageDataUrl(SVG_AS_PNG)).toBe(false);
  });

  it("真实 PNG 即使被声明成 jpeg 也判为可发送", () => {
    const mislabeled = PNG.replace("image/png", "image/jpeg");
    expect(detectImageMimeType(mislabeled)).toBe("image/png");
    expect(isProviderSafeImageDataUrl(mislabeled)).toBe(true);
  });

  it("无法识别的数据判为不可发送", () => {
    expect(isProviderSafeImageDataUrl("data:image/png;base64,YWJj")).toBe(false);
    expect(isProviderSafeImageDataUrl("")).toBe(false);
  });
});
