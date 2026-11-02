/**
 * 系统通知（Electron Notification）只认纯文本，不支持 Markdown 渲染。
 * 直接把消息原文塞进通知正文，用户会看到 `## 标题`、反引号、列表符号这些
 * 原始标记（Windows 通知气泡里尤其明显）。
 *
 * 这里做一次「结构降级」：只去掉标记、保留可读文字，不追求完整 Markdown
 * 语义（不做嵌套/表格对齐），也刻意不处理单下划线斜体 —— 那会把
 * snake_case 之类的标识符吃掉。
 */
export function markdownToPlainText(value: string): string {
  let text = String(value || "");

  // 内部 XML / HTML 标签（消息里可能有 <file ...> 之类的信封）
  text = text.replace(/<[^>\n]+>/g, " ");
  // 图片保留 alt 文字，链接保留可见文字
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 代码块围栏行（``` / ~~~）直接丢掉，块内文字保留
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, " ");
  // 行内代码 → 内容
  text = text.replace(/`+([^`]*)`+/g, "$1");
  // 标题标记
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // 引用块标记
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, "");
  // 列表 / 有序列表前缀
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "");
  // 表格分隔行（|---|---|）
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, " ");
  // 表格竖线
  text = text.replace(/[ \t]*\|[ \t]*/g, " ");
  // 分隔线
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ");
  // 加粗 / 删除线（成对标记，保留内部文字）
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/~~(.+?)~~/g, "$1");

  return text;
}
