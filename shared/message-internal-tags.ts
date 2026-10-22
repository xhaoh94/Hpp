/**
 * 内部标签清洗（共享给桌面端与移动端）。
 *
 * 发送给 Agent 的正文里带信封 XML：`<file path="..." lines="1-2">正文</file>`、
 * `<folder path="..." />`、`<image_attachment name="..." />`、`<source ... />`
 * 以及 fork 用的 `<current_user_message>`。这些标签是给模型的，不是给人看的。
 *
 * 但历史消息常常只留下了这份裸 content：
 * - 旧版本 Hpp 没有把 displayContent / sendContent 分开保存；
 * - 分叉、重发等路径会把 sendContent 写回消息正文。
 *
 * 于是它们会出现在聊天气泡、会话标题、侧栏预览里。本模块只把标签替换成
 * 可读形式，**不修改消息本身**——原始 content 仍要原样发给 Agent。
 */

/** 只起包裹作用、不携带信息的标签；预览与气泡里没有意义。 */
export const MESSAGE_WRAPPER_TAG = /<\/?(?:current_user_message|fork_context|message|conversation)>/g;

/**
 * 取路径末段。
 * 发送侧统一用正斜杠，但 Windows 上用户可能手输反斜杠，所以两种分隔符都认。
 * 注意不要先 strip 尾部斜杠 —— `G:\Work\a.ts` 里的末段不能被当成空段吃掉。
 */
export function basenameOf(rawPath: string): string {
  const cleaned = String(rawPath || "");
  const segment = cleaned.split(/[\\/]/).filter(Boolean).pop() || "";
  return segment || cleaned;
}

/** `<file|folder path="..." />`：没有读取正文时 payload 直接生成的自闭合形式。 */
const SELF_CLOSING_PATH_TAG = /<(file|folder)\s+[^>]*\bpath=(?:"([^"]*)"|'([^']*)')[^>]*\/\s*>/g;

/** `<file|folder path="...">…</file>`：携带正文（用于 file 的起止行显示）。 */
const PAIRED_PATH_TAG = /<(file|folder)\s+[^>]*\bpath=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/\1>/g;

const IMAGE_ATTACHMENT_TAG = /<image_attachment\s+[^>]*\bname="([^"]*)"[^>]*\/>/g;

const SOURCE_SESSION_TAG = /<source\s+[^>]*\btitle="([^"]*)"[^>]*\/>/g;

const labelForPathTag = (kind: string, path: string, attributes: string) => {
  const name = basenameOf(path);
  if (kind === "folder") return `[folder: ${name}]`;
  // 带 lines 的 file 标签用 `[file: name.lua:10-42]` 形式，与编辑器跳转标签一致。
  const lines = /\blines="(\d+)-(\d+)"/.exec(attributes);
  return lines ? `[file: ${name}:${lines[1]}-${lines[2]}]` : `[file: ${name}]`;
};

/** 把裸 content 里的内部 XML 标签换成可读的 `[file: 文件名]` 形式。 */
export function stripInternalTags(content: string): string {
  let result = String(content || "");
  // 自闭合形式必须先处理：否则成对规则可能把它当成起始标签，吞掉后面的正文。
  result = result.replace(
    SELF_CLOSING_PATH_TAG,
    (_full, kind: string, doubleQuotedPath?: string, singleQuotedPath?: string) =>
      labelForPathTag(kind, String(doubleQuotedPath ?? singleQuotedPath ?? ""), ""),
  );
  result = result.replace(
    PAIRED_PATH_TAG,
    (full, kind: string, doubleQuotedPath?: string, singleQuotedPath?: string) =>
      labelForPathTag(kind, String(doubleQuotedPath ?? singleQuotedPath ?? ""), full),
  );
  result = result.replace(
    IMAGE_ATTACHMENT_TAG,
    (_full, name: string) => `[image: ${basenameOf(String(name))}]`,
  );
  result = result.replace(
    SOURCE_SESSION_TAG,
    (_full, title: string) => `[引用会话: ${String(title)}]`,
  );
  return result;
}
