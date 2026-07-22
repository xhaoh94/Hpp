import { describe, expect, it } from "vitest";
import { isFileTreePathWithin, isSameFileTreePath, normalizeFileTreePath } from "./file-tree-paths";

describe("file tree path matching", () => {
  it("normalizes separators and trailing slashes", () => {
    expect(normalizeFileTreePath("C:\\work\\src\\")).toBe("C:/work/src");
    expect(normalizeFileTreePath("/work/src///")).toBe("/work/src");
  });

  it("compares Windows paths case-insensitively", () => {
    expect(isSameFileTreePath("C:\\Work\\src\\App.tsx", "c:/work/src/App.tsx")).toBe(true);
    expect(isFileTreePathWithin("C:\\Work\\src\\App.tsx", "c:/work/src")).toBe(true);
  });

  it("matches a directory itself and descendants at path boundaries", () => {
    expect(isFileTreePathWithin("/work/src", "/work/src")).toBe(true);
    expect(isFileTreePathWithin("/work/src/components/App.tsx", "/work/src")).toBe(true);
    expect(isFileTreePathWithin("/work/src-old/App.tsx", "/work/src")).toBe(false);
    expect(isFileTreePathWithin("/work/src", "/work/src-old")).toBe(false);
  });

  it("keeps POSIX path casing significant", () => {
    expect(isSameFileTreePath("/work/Src/App.tsx", "/work/src/App.tsx")).toBe(false);
    expect(isFileTreePathWithin("/work/Src/App.tsx", "/work/src")).toBe(false);
    expect(isFileTreePathWithin("/work/src/App.tsx", "/")).toBe(true);
  });
});
