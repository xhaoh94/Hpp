import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("content area tab lifetime", () => {
  it("keeps the file explorer mounted while other sidebar tabs are active", () => {
    const source = readWorkspaceFile("src/components/layout/ContentArea.tsx");
    const styles = readWorkspaceFile("src/components/layout/Layout.css");

    expect(source).toContain('className="sidebar-tab-view" hidden={sidebarTab !== "files"}');
    expect(source).toContain("<FileExplorer />");
    expect(source).not.toContain('sidebarTab === "files" && <FileExplorer />');
    expect(styles).toContain(".sidebar-tab-view[hidden]");
    expect(styles).toContain("display: none");
  });
});
