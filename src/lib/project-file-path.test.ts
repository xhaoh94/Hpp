import { describe, expect, it } from "vitest";
import {
  getLocalMarkdownCodePath,
  getLocalMarkdownFilePath,
  isAbsoluteProjectFilePath,
  resolveProjectFilePath,
} from "./project-file-path";

describe("project file path resolution", () => {
  it("resolves relative Agent file paths from a Windows project root", () => {
    expect(resolveProjectFilePath("CODEBUDDY.md", "C:\\work\\project"))
      .toBe("C:\\work\\project\\CODEBUDDY.md");
    expect(resolveProjectFilePath("./src/App.tsx", "C:\\work\\project\\"))
      .toBe("C:\\work\\project\\src/App.tsx");
  });

  it("resolves relative Agent file paths from a POSIX project root", () => {
    expect(resolveProjectFilePath("src/App.tsx", "/home/user/project/"))
      .toBe("/home/user/project/src/App.tsx");
  });

  it("keeps absolute paths unchanged", () => {
    expect(resolveProjectFilePath("C:\\work\\project\\README.md", "D:\\other"))
      .toBe("C:\\work\\project\\README.md");
    expect(resolveProjectFilePath("/home/user/project/README.md", "/other"))
      .toBe("/home/user/project/README.md");
    expect(resolveProjectFilePath("\\\\server\\share\\README.md", "C:\\work"))
      .toBe("\\\\server\\share\\README.md");
  });

  it("recognizes Windows, UNC, and POSIX absolute paths", () => {
    expect(isAbsoluteProjectFilePath("C:/work/file.ts")).toBe(true);
    expect(isAbsoluteProjectFilePath("\\\\server\\share\\file.ts")).toBe(true);
    expect(isAbsoluteProjectFilePath("/work/file.ts")).toBe(true);
    expect(isAbsoluteProjectFilePath("src/file.ts")).toBe(false);
  });

  it("extracts local files from Markdown links", () => {
    expect(getLocalMarkdownFilePath("Docs/%E6%8C%87%E5%8D%97.md"))
      .toBe("Docs/指南.md");
    expect(getLocalMarkdownFilePath("src/App.tsx?plain=1#L10"))
      .toBe("src/App.tsx");
    expect(getLocalMarkdownFilePath("C:/work/project/README.md"))
      .toBe("C:/work/project/README.md");
  });

  it("leaves web URLs and document anchors to normal link handling", () => {
    expect(getLocalMarkdownFilePath("https://example.com/docs.md")).toBeNull();
    expect(getLocalMarkdownFilePath("mailto:test@example.com")).toBeNull();
    expect(getLocalMarkdownFilePath("//example.com/docs.md")).toBeNull();
    expect(getLocalMarkdownFilePath("#section")).toBeNull();
  });

  it("recognizes project paths rendered as Markdown code", () => {
    expect(getLocalMarkdownCodePath("Assets/WX-WASM-SDK-V2/Editor/MiniGameConfig.asset"))
      .toBe("Assets/WX-WASM-SDK-V2/Editor/MiniGameConfig.asset");
    expect(getLocalMarkdownCodePath("Docs/Source/微信小游戏温控系统官方文档.md\n"))
      .toBe("Docs/Source/微信小游戏温控系统官方文档.md");
    expect(getLocalMarkdownCodePath("README.md")).toBe("README.md");
  });

  it("does not treat ordinary code or web URLs as project paths", () => {
    expect(getLocalMarkdownCodePath("npm run build")).toBeNull();
    expect(getLocalMarkdownCodePath("https://example.com/file.md")).toBeNull();
    expect(getLocalMarkdownCodePath("plainIdentifier")).toBeNull();
  });
});
