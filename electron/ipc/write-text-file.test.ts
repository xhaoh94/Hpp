import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeTextFile, MAX_WRITE_TEXT_BYTES } from "./write-text-file";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "hpp-write-text-"));
}

describe("writeTextFile", () => {
  it("writes content and reads it back", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "a.txt");
    const result = await writeTextFile(filePath, "hello\n世界\n");
    expect(result.success).toBe(true);
    expect(await readFile(filePath, "utf-8")).toBe("hello\n世界\n");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects invalid path", async () => {
    const result = await writeTextFile("", "x");
    expect(result.success).toBe(false);
  });

  it("rejects non-string content", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "a.txt");
    const result = await writeTextFile(filePath, 123 as unknown as string);
    expect(result.success).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects content exceeding the size limit", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "big.txt");
    const big = "x".repeat(MAX_WRITE_TEXT_BYTES + 1);
    const result = await writeTextFile(filePath, big);
    expect(result.success).toBe(false);
    expect(result.error).toContain("过大");
    await rm(dir, { recursive: true, force: true });
  });

  it("reports error when the target directory does not exist", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "missing", "a.txt");
    const result = await writeTextFile(filePath, "x");
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    await rm(dir, { recursive: true, force: true });
  });

  it("overwrites an existing file", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "a.txt");
    await writeFile(filePath, "old", "utf-8");
    const result = await writeTextFile(filePath, "new");
    expect(result.success).toBe(true);
    expect(await readFile(filePath, "utf-8")).toBe("new");
    await rm(dir, { recursive: true, force: true });
  });
});
