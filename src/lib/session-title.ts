/** 侧栏、历史列表与顶部标题共用的会话标题长度上限。 */
export const SESSION_TITLE_MAX_CHARS = 48;

const PLACEHOLDER_PREFIX = "新会话 - ";
const PLACEHOLDER_TITLE = "新会话";
const TRAILING_ELLIPSIS = "...";

/** 新建会话时的占位标题：真实标题要等首条用户消息才确定。 */
export const createDefaultSessionTitle = (now: Date = new Date()) =>
  `${PLACEHOLDER_PREFIX}${now.toLocaleString("zh-CN")}`;

/**
 * 会话标题是否仍是「还没被真实内容替换过」的占位值。
 *
 * 会话正文按需从 SQLite 加载，未加载时侧栏页签/历史列表只能回退到
 * `session.title`；如果这个字段永远停在创建时的「新会话 - <时间>」，
 * 一个很久没打开的真实会话看起来就像刚建好的空会话。
 */
export const isPlaceholderSessionTitle = (title: string) => {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (trimmed === PLACEHOLDER_TITLE) return true;
  return trimmed.startsWith(PLACEHOLDER_PREFIX);
};

/** 把首条用户消息的预览压成会话标题。 */
export const toSessionTitle = (preview: string) => {
  const text = preview.replace(/\s+/g, " ").trim();
  if (text.length <= SESSION_TITLE_MAX_CHARS) return text;
  return `${text.slice(0, SESSION_TITLE_MAX_CHARS - TRAILING_ELLIPSIS.length).trimEnd()}${TRAILING_ELLIPSIS}`;
};

/**
 * 拿到首条用户消息后，占位标题就应该换成真实标题；已有真实标题
 * （包括「分叉 - …」）时保持不动。
 */
export const resolveSessionTitle = (currentTitle: string, preview: string) => {
  if (!preview.trim() || !isPlaceholderSessionTitle(currentTitle)) return currentTitle;
  return toSessionTitle(preview);
};
