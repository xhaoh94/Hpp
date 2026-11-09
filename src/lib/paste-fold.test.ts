import { describe, expect, it } from "vitest";
import {
  PASTE_FOLD_MIN_CHARS,
  PASTE_FOLD_MIN_LINES,
  PASTE_PREVIEW_MAX_LINES,
  formatPastedTextSize,
  getPastedTextHeadline,
  getPastedTextPreview,
  isPastedTextTooLarge,
  shouldFoldPastedText,
} from "./paste-fold";
import { MAX_COMPOSER_PASTE_CHARS } from "@shared/composer-document";

describe("shouldFoldPastedText", () => {
  it("keeps short pastes inline so they stay editable in place", () => {
    expect(shouldFoldPastedText("hello")).toBe(false);
    expect(shouldFoldPastedText("x".repeat(PASTE_FOLD_MIN_CHARS - 1))).toBe(false);
    expect(shouldFoldPastedText(Array.from({ length: PASTE_FOLD_MIN_LINES - 1 }, () => "l").join("\n"))).toBe(false);
  });

  it("folds on either threshold", () => {
    expect(shouldFoldPastedText("x".repeat(PASTE_FOLD_MIN_CHARS))).toBe(true);
    expect(shouldFoldPastedText(Array.from({ length: PASTE_FOLD_MIN_LINES }, () => "l").join("\n"))).toBe(true);
  });
});

describe("isPastedTextTooLarge", () => {
  it("matches the send-side size limit", () => {
    expect(isPastedTextTooLarge("x".repeat(MAX_COMPOSER_PASTE_CHARS))).toBe(false);
    expect(isPastedTextTooLarge("x".repeat(MAX_COMPOSER_PASTE_CHARS + 1))).toBe(true);
  });
});

describe("getPastedTextPreview", () => {
  it("returns the whole text when it fits", () => {
    expect(getPastedTextPreview("a\nb")).toEqual({ text: "a\nb", totalLines: 2, truncated: false });
  });

  it("caps rendering but still reports the real line count", () => {
    const text = Array.from({ length: PASTE_PREVIEW_MAX_LINES + 5 }, (_, index) => `l${index + 1}`).join("\n");

    const preview = getPastedTextPreview(text);

    expect(preview.truncated).toBe(true);
    expect(preview.totalLines).toBe(PASTE_PREVIEW_MAX_LINES + 5);
    expect(preview.text.split("\n")).toHaveLength(PASTE_PREVIEW_MAX_LINES);
  });
});

describe("paste label formatting", () => {
  it("formats byte sizes", () => {
    expect(formatPastedTextSize(0)).toBe("0 B");
    expect(formatPastedTextSize(900)).toBe("900 B");
    expect(formatPastedTextSize(8602)).toBe("8.4 KB");
    expect(formatPastedTextSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("prefers line counts for multi-line pastes and char counts for one-liners", () => {
    expect(getPastedTextHeadline({ chars: 12_000, lines: 300, bytes: 12_000 })).toBe("300 行");
    expect(getPastedTextHeadline({ chars: 4000, lines: 1, bytes: 4000 })).toBe("4000 字符");
  });
});
