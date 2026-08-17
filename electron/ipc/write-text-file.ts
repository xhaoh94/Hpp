import { writeFile, rename, unlink } from "fs/promises";

export const MAX_WRITE_TEXT_BYTES = 10 * 1024 * 1024; // 10 MB — matches readFile limit

/**
 * Write text content to a file using an atomic strategy (temp file + rename),
 * so a crashed save never leaves a truncated file behind.
 */
export async function writeTextFile(
  filePath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { success: false, error: "Invalid file path" };
  }
  if (typeof content !== "string") {
    return { success: false, error: "Invalid file content" };
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_TEXT_BYTES) {
    return { success: false, error: "文件过大，无法保存" };
  }

  const tempPath = `${filePath}.hpp-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, filePath);
    return { success: true };
  } catch (err: unknown) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup failures — the temp file may not exist.
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
