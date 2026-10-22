/**
 * 可以直接在浏览器里跑起来看效果的语言：整页 HTML 与 SVG。
 *
 * 其余语言（ts/vue/lua/py…）要么需要构建步骤、要么不是页面，不给运行按钮——
 * 按钮点下去打不开东西比没有按钮更糟。
 */
export const RUNNABLE_CODE_LANGUAGES = new Set(["html", "svg"]);

const HTML_DOCUMENT_HEAD = /^<!DOCTYPE html|^<html[\s>]/i;
const SVG_DOCUMENT_HEAD = /^<svg[\s>]|^<\?xml[\s\S]*?<svg[\s>]/i;

/**
 * 判断一个代码块能不能本地运行，返回运行语言；不能则返回 null。
 *
 * 优先看语言标签；没有标签时按内容嗅探——只认**文档级**标记
 * （`<!DOCTYPE html>` / `<html>` / `<svg>`），HTML 片段和普通代码不给按钮，
 * 免得点下去打开一个渲染不出来的残页。
 */
export function getRunnableCodeKind(language: string, code: string): "html" | "svg" | null {
  const normalized = (language || "").trim().toLowerCase();
  if (RUNNABLE_CODE_LANGUAGES.has(normalized)) return normalized as "html" | "svg";
  if (normalized) return null;

  const head = (code || "").trimStart().slice(0, 256);
  if (HTML_DOCUMENT_HEAD.test(head)) return "html";
  if (SVG_DOCUMENT_HEAD.test(head)) return "svg";
  return null;
}
