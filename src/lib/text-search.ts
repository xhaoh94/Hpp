/**
 * 纯文本搜索逻辑：无 highlight.js / lowlight 依赖，可被 Web Worker 安全导入。
 *
 * 从 file-preview-code.ts 提取，供主线程与 Worker 共用，避免 Worker 打包时
 * 意外引入 createLowlight(common) 等重量级副作用。
 */

export interface SearchMatch {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
}

export interface TextSearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface IndexedSearchMatch extends SearchMatch {
  matchIndex: number;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;

function getPreviousCharacter(value: string, index: number) {
  return value.slice(0, index).match(/.$/u)?.[0] || "";
}

function getNextCharacter(value: string, index: number) {
  return value.slice(index).match(/^./u)?.[0] || "";
}

function isWholeWordMatch(line: string, query: string, startColumn: number, endColumn: number) {
  const queryCharacters = Array.from(query);
  const firstQueryCharacter = queryCharacters[0] || "";
  const lastQueryCharacter = queryCharacters[queryCharacters.length - 1] || "";
  const previousCharacter = getPreviousCharacter(line, startColumn);
  const nextCharacter = getNextCharacter(line, endColumn);

  return !(
    (WORD_CHARACTER_PATTERN.test(firstQueryCharacter) && WORD_CHARACTER_PATTERN.test(previousCharacter))
    || (WORD_CHARACTER_PATTERN.test(lastQueryCharacter) && WORD_CHARACTER_PATTERN.test(nextCharacter))
  );
}

export function findTextMatches(
  lines: string[],
  query: string,
  options: TextSearchOptions = {},
): SearchMatch[] {
  if (!query) return [];
  let expression: RegExp;
  try {
    // 正则模式：query 即正则源；普通模式：先转义避免特殊字符被当作正则元字符。
    expression = new RegExp(
      options.regex ? query : escapeRegExp(query),
      options.matchCase ? "gu" : "giu",
    );
  } catch {
    // 非法正则：当作无结果，由调用方展示错误态。
    return [];
  }
  const matches: SearchMatch[] = [];

  lines.forEach((line, lineIndex) => {
    expression.lastIndex = 0;
    for (const match of line.matchAll(expression)) {
      const startColumn = match.index ?? 0;
      const endColumn = startColumn + match[0].length;
      // 正则模式下全字匹配无意义（VSCode 会在正则开启时禁用该选项）。
      if (options.wholeWord && !options.regex && !isWholeWordMatch(line, query, startColumn, endColumn)) continue;
      matches.push({
        lineNumber: lineIndex + 1,
        startColumn,
        endColumn,
      });
    }
  });

  return matches;
}

export function isRegexValid(query: string, matchCase: boolean): boolean {
  try {
    new RegExp(query, matchCase ? "gu" : "giu");
    return true;
  } catch {
    return false;
  }
}

export function getNextSearchMatchIndex(
  currentIndex: number,
  totalMatches: number,
  direction: 1 | -1,
): number {
  if (totalMatches <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= totalMatches) {
    return direction === 1 ? 0 : totalMatches - 1;
  }
  return (currentIndex + direction + totalMatches) % totalMatches;
}

// 保留大小写替换：a) 原文全大写 → 替换全大写；b) 原文首字母大写、其余小写（title case）→ 替换按同样规则改写。
// 供当前文件替换与"所有文件"搜索结果预览/替换复用，避免逻辑分叉。
export function applyPreserveCase(original: string, replacement: string): string {
  if (!replacement) return replacement;
  if (original.toUpperCase() === original && original.toLowerCase() !== original) {
    return replacement.toUpperCase();
  }
  const firstLetter = original.match(/\p{L}/u);
  if (firstLetter) {
    const fi = firstLetter.index ?? 0;
    const firstChar = original[fi];
    const rest = original.slice(fi + 1);
    const isTitle =
      firstChar === firstChar.toUpperCase() &&
      firstChar !== firstChar.toLowerCase() &&
      (rest === rest.toLowerCase() || !/\p{L}/u.test(rest));
    if (isTitle) {
      const repFirst = replacement.match(/\p{L}/u);
      if (repFirst) {
        const ri = repFirst.index ?? 0;
        return (
          replacement.slice(0, ri) +
          replacement[ri].toUpperCase() +
          replacement.slice(ri + 1).toLowerCase()
        );
      }
    }
  }
  return replacement;
}
