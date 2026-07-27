import { describe, expect, it } from "vitest";
import titleBarSource from "./TitleBar.tsx?raw";

describe("title bar compositor integration", () => {
  it("leaves sizing controls to niri", () => {
    expect(titleBarSource).toContain("if (isNiri) return");
    expect(titleBarSource).toContain("{!isNiri && (");

    const niriGuardedControls = titleBarSource.slice(
      titleBarSource.indexOf("{!isNiri && ("),
      titleBarSource.indexOf('className="titlebar-btn titlebar-btn-close"'),
    );
    expect(niriGuardedControls).toContain("titlebar-btn-minimize");
    expect(niriGuardedControls).toContain("titlebar-btn-maximize");
  });
});
