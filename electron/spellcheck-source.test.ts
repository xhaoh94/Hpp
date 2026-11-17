import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop spellcheck source constraints", () => {
  it("disables spellcheck at the main window level so no input shows red squiggles", () => {
    const main = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");
    const quickAsk = readFileSync(resolve(process.cwd(), "electron/quick-ask.ts"), "utf8");

    // 主窗口是全局开关：只靠 renderer 里逐个 spellCheck={false} 会漏掉其它输入框。
    expect(main).toContain("spellcheck: false");
    expect(main).not.toContain("spellcheck: true");
    expect(quickAsk).toContain("spellcheck: false");
  });
});
