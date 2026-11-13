import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

// The project currently has no declarations for worker-side .mjs modules.
// @ts-expect-error Hpp worker extension is intentionally shipped as ESM.
import { createHppPresentExtension, normalizePresentedPaths, resolvePresentedPath } from "./present-extension.mjs";

const registerTools = (factory: (pi: unknown) => void) => {
  const tools: Array<Record<string, any>> = [];
  factory({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
  return tools;
};

describe("Pi present_files extension", () => {
  it("注册一个 present_files 工具，缺少 registerTool 时静默跳过", () => {
    const tools = registerTools(createHppPresentExtension());
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("present_files");
    expect(tools[0].parameters.required).toEqual(["files"]);

    expect(() => createHppPresentExtension()({})).not.toThrow();
  });

  it("只接受数组或单个字符串，去重并限制数量", () => {
    expect(normalizePresentedPaths({ files: ["a.png", "a.png", " b.pdf "] })).toEqual(["a.png", "b.pdf"]);
    expect(normalizePresentedPaths({ paths: ["a.png"] })).toEqual(["a.png"]);
    expect(normalizePresentedPaths("a.png")).toEqual(["a.png"]);
    expect(normalizePresentedPaths({ files: [] })).toEqual([]);
    expect(normalizePresentedPaths(undefined)).toEqual([]);
    expect(normalizePresentedPaths({ files: Array.from({ length: 30 }, (_, i) => `f${i}.png`) })).toHaveLength(20);
  });

  it("相对路径按会话工作目录解析，绝对路径原样保留", () => {
    const base = tmpdir();
    const slash = (value: string) => value.replace(/\\/g, "/");
    expect(slash(resolvePresentedPath("out/report.pdf", base))).toBe(`${slash(base)}/out/report.pdf`);
    const absolute = join(base, "abs.pdf");
    expect(resolvePresentedPath(absolute, base)).toBe(absolute);
    expect(resolvePresentedPath("   ", base)).toBe("");
  });

  it("返回存在的绝对路径，缺失的单独列出且不伪造成功", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpp-present-"));
    try {
      await writeFile(join(root, "report.txt"), "ok", "utf8");
      const [tool] = registerTools(createHppPresentExtension());
      const ok = await tool.execute(
        "call-1",
        { files: ["report.txt", "missing.txt"], summary: "交付报告" },
        new AbortController().signal,
        undefined,
        { cwd: root },
      );
      expect(ok.isError).toBeUndefined();
      expect(ok.details.files).toEqual([join(root, "report.txt")]);
      expect(ok.details.missing).toEqual([join(root, "missing.txt")]);
      expect(ok.content[0].text).toContain("交付报告");

      const failed = await tool.execute(
        "call-2",
        { files: ["missing.txt"] },
        new AbortController().signal,
        undefined,
        { cwd: root },
      );
      expect(failed.isError).toBe(true);
      expect(failed.details.files).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("files 为空时直接报错，不产生空声明", async () => {
    const [tool] = registerTools(createHppPresentExtension());
    const result = await tool.execute(
      "call-empty",
      { files: [] },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(result.details.files).toEqual([]);
  });
});
