import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop theme source constraints", () => {
  it("keeps sidebar collapse compositing on the active theme background", () => {
    const layoutStyles = readFileSync(
      resolve(process.cwd(), "src/components/layout/Layout.css"),
      "utf8",
    );
    const desktopHtml = readFileSync(resolve(process.cwd(), "src/index.html"), "utf8");

    expect(layoutStyles).toMatch(/\.layout-content\s*\{[^}]*background-color:\s*var\(--bg-primary\)/s);
    expect(desktopHtml).not.toMatch(/<body[^>]*(?:#1e1e1e|#252526)/i);
  });
});
