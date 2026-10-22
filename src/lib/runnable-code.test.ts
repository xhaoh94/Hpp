import { describe, expect, it } from "vitest";
import { RUNNABLE_CODE_LANGUAGES, getRunnableCodeKind } from "./runnable-code";

describe("runnable code languages", () => {
  it("treats whole-page HTML and SVG as runnable", () => {
    expect(RUNNABLE_CODE_LANGUAGES.has("html")).toBe(true);
    expect(RUNNABLE_CODE_LANGUAGES.has("svg")).toBe(true);
  });

  it("keeps build-step or non-page languages out", () => {
    for (const language of ["", "ts", "tsx", "vue", "js", "lua", "py", "json", "css", "markdown", "htm"]) {
      expect(RUNNABLE_CODE_LANGUAGES.has(language)).toBe(false);
    }
  });
});

describe("runnable code kind detection", () => {
  it("uses the explicit language tag when present", () => {
    expect(getRunnableCodeKind("html", "anything")).toBe("html");
    expect(getRunnableCodeKind("SVG", "anything")).toBe("svg");
    expect(getRunnableCodeKind("ts", "<html></html>")).toBeNull();
    expect(getRunnableCodeKind("vue", "<template></template>")).toBeNull();
  });

  it("sniffs untagged full-page HTML and SVG documents", () => {
    expect(getRunnableCodeKind("", "<!DOCTYPE html>\n<html><body>hi</body></html>")).toBe("html");
    expect(getRunnableCodeKind("", "  \n<html lang=\"en\"><body></body></html>")).toBe("html");
    expect(getRunnableCodeKind("", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")).toBe("svg");
    expect(getRunnableCodeKind("", "<?xml version=\"1.0\"?>\n<svg></svg>")).toBe("svg");
  });

  it("does not offer to run fragments or ordinary code", () => {
    expect(getRunnableCodeKind("", "<div class=\"x\">fragment</div>")).toBeNull();
    expect(getRunnableCodeKind("", "const a = 1;")).toBeNull();
    expect(getRunnableCodeKind("", "npm run build")).toBeNull();
    expect(getRunnableCodeKind("", "")).toBeNull();
  });
});
