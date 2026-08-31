import {
  parseComposerDocument,
  type ComposerDocument,
} from "@shared/composer-document";

/**
 * 复制发言气泡时，除纯文本外还想把附件芯片（代码片段 / 路径 / 会话引用 /
 * 图片）一起带回来。系统剪贴板的自定义格式在 Chromium 里不可靠（Electron 下
 * clipboard.write 可能挂起或被权限拒绝），因此以「渲染进程内存副本 + 纯文本
 * 指纹匹配」为主：粘贴事件里的纯文本若与最近复制的气泡纯文本一致，就还原
 * 内存里的文档；navigator.clipboard.write 的自定义格式只作为附加项写入，
 * 带超时竞速，失败自动退回纯文本，绝不让复制挂住。
 */
export const COMPOSER_CLIPBOARD_MIME = "web application/vnd.hpp.composer-document+json";

/** 图片是 data URL，多张大图可能撑爆剪贴板负载；超限则丢弃图片节点再写。 */
const MAX_COMPOSER_CLIPBOARD_BYTES = 8 * 1024 * 1024;
/** clipboard.write 在部分 Electron 环境会永久挂起，超时后立即退回纯文本。 */
const WRITE_TIMEOUT_MS = 2000;

const PAYLOAD_KIND = "hpp-composer-document";

type CopiedComposer = {
  /** 与纯文本 flavor 完全一致的内容（归一化 \r\n 后），作为粘贴时的指纹。 */
  plainText: string;
  document: ComposerDocument;
};

let lastCopied: CopiedComposer | null = null;

const normalizeText = (value: string) => value.replace(/\r\n/g, "\n");

export function serializeComposerClipboard(document: ComposerDocument): string {
  const serialized = JSON.stringify({ kind: PAYLOAD_KIND, document });
  if (serialized.length <= MAX_COMPOSER_CLIPBOARD_BYTES) return serialized;
  const trimmed: ComposerDocument = {
    version: document.version,
    nodes: document.nodes.filter((node) => node.type !== "image"),
  };
  return JSON.stringify({ kind: PAYLOAD_KIND, document: trimmed });
}

export function parseComposerClipboard(text: string | null | undefined): ComposerDocument | null {
  if (!text || !text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || (parsed as { kind?: unknown }).kind !== PAYLOAD_KIND) {
      return null;
    }
    const document = parseComposerDocument((parsed as { document?: unknown }).document);
    return document && document.nodes.length > 0 ? document : null;
  } catch {
    return null;
  }
}

/**
 * 复制气泡内容：内存里留存文档副本，并把自定义格式与纯文本一起写入系统剪贴板。
 * 自定义格式写入失败 / 超时会退回 writeText 纯文本，本函数不会抛出。
 */
export async function writeComposerClipboard(
  document: ComposerDocument,
  plainText: string,
): Promise<void> {
  if (!document.nodes.length) return;
  lastCopied = { plainText: normalizeText(plainText), document };
  const payload = serializeComposerClipboard(document);
  try {
    const write = navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([plainText], { type: "text/plain" }),
      [COMPOSER_CLIPBOARD_MIME]: new Blob([payload], { type: "application/json" }),
    })]);
    await Promise.race([
      write,
      new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard write timeout")), WRITE_TIMEOUT_MS)),
    ]);
  } catch {
    try {
      await navigator.clipboard.writeText(plainText);
    } catch {
      // 系统剪贴板完全不可用时仍有内存副本，粘贴指纹匹配不受影响。
    }
  }
}

/**
 * 粘贴时尝试还原气泡文档：优先读系统剪贴板里的自定义格式（跨窗口复制），
 * 否则用纯文本指纹匹配内存副本（同窗口、且用户没有再复制过别的内容）。
 */
export function readCopiedComposer(
  plainText: string | null | undefined,
  customPayload?: string | null,
): ComposerDocument | null {
  const fromFlavor = parseComposerClipboard(customPayload);
  if (fromFlavor) return fromFlavor;
  if (!plainText || !lastCopied) return null;
  return normalizeText(plainText) === lastCopied.plainText ? lastCopied.document : null;
}
