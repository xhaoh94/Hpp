import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("content area tab lifetime", () => {
  it("keeps stateful project and file tabs mounted while other sidebar tabs are active", () => {
    const source = readWorkspaceFile("src/components/layout/ContentArea.tsx");
    const styles = readWorkspaceFile("src/components/layout/Layout.css");

    expect(source).toContain('className="sidebar-tab-view" hidden={sidebarTab !== "projects"}');
    expect(source).toContain("<ProjectView />");
    expect(source).not.toContain('sidebarTab === "projects" && <ProjectView />');
    expect(source).toContain('className="sidebar-tab-view" hidden={sidebarTab !== "files"}');
    expect(source).toContain("<FileExplorer />");
    expect(source).not.toContain('sidebarTab === "files" && <FileExplorer />');
    expect(styles).toContain(".sidebar-tab-view[hidden]");
    expect(styles).toContain("display: none");
  });

  it("keeps the collapsed hover panel above chat content without raising the regular sidebar", () => {
    const styles = readWorkspaceFile("src/components/layout/Layout.css");
    const collapsedPanel = Array.from(styles.matchAll(
      /\.layout-content\.collapsed \.sidebar-panel\s*\{([\s\S]*?)\}/g,
    )).at(-1)?.[1];
    const hoverPanel = styles.match(
      /\.layout-content\.collapsed\.hover-expanded \.sidebar-panel\s*\{([\s\S]*?)\}/g,
    )?.at(-1);

    expect(collapsedPanel).toContain("position: absolute");
    expect(collapsedPanel).toContain("z-index: 15");
    expect(hoverPanel).toContain("z-index: 200");
    expect(Number(hoverPanel?.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThan(25);
    expect(styles).not.toMatch(/\.layout-content\s*\{[^}]*overflow:\s*hidden/s);
  });
});
