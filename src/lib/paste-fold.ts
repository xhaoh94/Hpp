import {
  MAX_COMPOSER_PASTE_CHARS,
  getComposerPasteStats,
  type ComposerPasteStats,
} from "@shared/composer-document";

/**
 * 粘贴折叠阈值：一次粘贴超过任一阈值就折叠成标签。
 * 1000 字符 / 10 行：比这再长的粘贴就会把输入框顶得很高，
 * 而十几行内的引用/命令片段留在输入框里就地修改更顺手。
 */
export const PASTE_FOLD_MIN_CHARS = 1000;
export const PASTE_FOLD_MIN_LINES = 10;

/**
 * 悬停浮层里最多渲染多少行原文。再长就只显示前这么多行 + 「还有 N 行」，
 * 避免 20 万字符一次性塞进 DOM 把界面拖住。
 */
export const PASTE_PREVIEW_MAX_LINES = 500;

/** 一次粘贴是否应该折叠成标签。 */
export function shouldFoldPastedText(text: string): boolean {
  const stats = getComposerPasteStats(text);
  return stats.chars >= PASTE_FOLD_MIN_CHARS || stats.lines >= PASTE_FOLD_MIN_LINES;
}

/** 超过发送上限的粘贴会被拒绝（而不是静默截断），由调用方给出提示。 */
export function isPastedTextTooLarge(text: string): boolean {
  return text.length > MAX_COMPOSER_PASTE_CHARS;
}

export type PastedTextPreview = {
  text: string;
  totalLines: number;
  truncated: boolean;
};

/** 浮层里实际渲染的文本：超长时截断到 PASTE_PREVIEW_MAX_LINES 行。 */
export function getPastedTextPreview(text: string): PastedTextPreview {
  const lines = text.split(/\r?\n/);
  if (lines.length <= PASTE_PREVIEW_MAX_LINES) {
    return { text, totalLines: lines.length, truncated: false };
  }
  return {
    text: lines.slice(0, PASTE_PREVIEW_MAX_LINES).join("\n"),
    totalLines: lines.length,
    truncated: true,
  };
}

/** 字节数的可读写法：8.4 KB / 1.2 MB，供标签与浮层标题使用。 */
export function formatPastedTextSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 标签上的主信息：多行优先说行数，单行大文本则说字符数。 */
export function getPastedTextHeadline(stats: ComposerPasteStats): string {
  return stats.lines > 1 ? `${stats.lines} 行` : `${stats.chars} 字符`;
}
