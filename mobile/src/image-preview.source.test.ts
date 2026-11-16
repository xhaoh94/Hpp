import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("mobile chat image preview", () => {
  it("opens a full-size preview from both message images and guidance images", () => {
    const app = readWorkspaceFile("mobile/src/App.tsx");

    // 两处缩略图都派发打开事件，而不是只给消息图片加。
    expect(app.match(/onClick=\{\(\) => openImagePreview\(image\.src, image\.name\)\}/g)).toHaveLength(2);
    expect(app).toContain('const OPEN_IMAGE_PREVIEW_EVENT = "hpp:open-image-preview"');
    expect(app).toContain("window.addEventListener(OPEN_IMAGE_PREVIEW_EVENT, onOpenImage)");
  });

  it("renders the preview overlay at the app root via a portal", () => {
    const app = readWorkspaceFile("mobile/src/App.tsx");

    expect(app).toContain("{imagePreview && createPortal(");
    expect(app).toContain('className="image-preview-overlay"');
    expect(app).toContain('aria-label="关闭大图"');
    expect(app).toContain("document.body,");
  });

  it("styles the overlay fixed above everything and marks thumbnails as zoomable", () => {
    const css = readWorkspaceFile("mobile/src/styles.css");

    expect(css).toContain(".image-preview-overlay {");
    expect(css).toContain("position: fixed;");
    expect(css).toContain("z-index: 2000;");
    expect(css).toContain(".process-guidance-images img { cursor: zoom-in; }");
  });
});
