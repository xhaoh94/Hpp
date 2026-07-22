export interface ActiveFileMention {
  query: string;
  start: number;
  end: number;
}

export interface FileMentionReplacement {
  value: string;
  caret: number;
}

const isWhitespace = (character: string) => /\s/u.test(character);
const isEmailOrIdentifierCharacter = (character: string) => /[A-Za-z0-9_.+@-]/u.test(character);
const isHorizontalWhitespace = (character: string) => /[^\S\r\n]/u.test(character);

export function parseActiveFileMention(
  value: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): ActiveFileMention | null {
  if (selectionStart !== selectionEnd) return null;
  if (!Number.isInteger(selectionStart) || selectionStart < 0 || selectionStart > value.length) return null;

  const caret = selectionStart;
  if (caret === 0) return null;
  const start = value.lastIndexOf("@", caret - 1);
  if (start < 0) return null;

  const query = value.slice(start + 1, caret);
  if ([...query].some((character) => character === "@" || isWhitespace(character))) return null;
  if (start > 0 && isEmailOrIdentifierCharacter(value[start - 1])) return null;

  let end = caret;
  while (end < value.length && value[end] !== "@" && !isWhitespace(value[end])) end += 1;

  return {
    query,
    start,
    end,
  };
}

export function replaceFileMentionToken(
  value: string,
  mention: Pick<ActiveFileMention, "start" | "end">,
  replacement = "",
): FileMentionReplacement {
  const start = Math.max(0, Math.min(value.length, mention.start));
  let end = Math.max(start, Math.min(value.length, mention.end));
  if (
    !replacement
    && end < value.length
    && isHorizontalWhitespace(value[end])
    && (start === 0 || isWhitespace(value[start - 1]))
  ) {
    end += 1;
  }
  return {
    value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
    caret: start + replacement.length,
  };
}
