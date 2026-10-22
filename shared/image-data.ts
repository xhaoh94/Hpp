/**
 * 图片附件的真实格式识别。
 *
 * 不能只信 `file.type` 或扩展名：`icon.svg` 被改名成 `icon.png`、某些站点把 SVG
 * 当作 png 提供、粘贴板给出的 type 与实际字节不一致等情况都会让渠道直接以
 * `You have uploaded an unsupported image` / `failed to decode image config`
 * 拒绝**整次**请求。所以发送前必须按 magic number 判断真实格式。
 */

/** 渠道真正能解码的格式（OpenAI 兼容 / Anthropic 等主流渠道一致）。 */
export const PROVIDER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const decodeBase64Head = (base64: string): Uint8Array | null => {
  const head = base64.slice(0, 64);
  try {
    if (typeof atob === "function") {
      const binary = atob(head.slice(0, head.length - (head.length % 4)));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    // Node（主进程 / 测试）环境。这里不引用 Buffer 类型：渲染端 tsconfig
    // 没有 Node 类型，只需要结构化声明就能调用。
    const buffer = (globalThis as {
      Buffer?: { from(input: string, encoding: string): Uint8Array };
    }).Buffer;
    if (buffer) return buffer.from(head, "base64");
  } catch {
    return null;
  }
  return null;
};

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

const asciiAt = (bytes: Uint8Array, offset: number, text: string) =>
  text.split("").every((char, index) => bytes[offset + index] === char.charCodeAt(0));

/** 从 data URL（或裸 base64）判断真实图片格式；无法识别时返回 undefined。 */
export function detectImageMimeType(value: string): string | undefined {
  const source = typeof value === "string" ? value : "";
  if (!source) return undefined;
  const separator = source.indexOf(",");
  const isDataUrl = source.startsWith("data:");
  const base64 = isDataUrl && separator >= 0 ? source.slice(separator + 1) : source;
  const bytes = decodeBase64Head(base64.replace(/\s+/g, ""));
  if (!bytes || bytes.length < 12) return undefined;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, 0, "GIF8")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  return undefined;
}

/**
 * 附件是否可以直接发给渠道。
 * 只看真实字节：声明成 png 的 SVG 同样会被判为不安全。
 */
export function isProviderSafeImageDataUrl(value: string): boolean {
  const actual = detectImageMimeType(value);
  return !!actual && PROVIDER_IMAGE_MIME_TYPES.has(actual);
}
