import { describe, expect, it } from "vitest";
import {
  buildExpandSearchRows,
  getExpandSearchVisibleRows,
  getExpandSearchPreviewParts,
  type ExpandSearchGroup,
  type ExpandSearchResult,
} from "./ExpandSearchList";

function makeGroups(fileCount: number, resultCount: number): ExpandSearchGroup[] {
  const groups: ExpandSearchGroup[] = Array.from({ length: fileCount }, (_, fileIndex) => ({
    path: `C:\\project\\file-${fileIndex}.ts`,
    name: `file-${fileIndex}.ts`,
    relPath: `file-${fileIndex}.ts`,
    dirPath: "C:\\project",
    matches: [],
  }));

  for (let index = 0; index < resultCount; index++) {
    const group = groups[index % fileCount];
    const match: ExpandSearchResult = {
      path: group.path,
      name: group.name,
      relPath: group.relPath,
      dirPath: group.dirPath,
      lineNumber: index + 1,
      preview: `const result${index} = "match";`,
      matchStart: 22,
      matchEnd: 27,
    };
    group.matches.push(match);
  }
  return groups;
}

describe("all-files search result virtualization", () => {
  it("builds a contiguous row model for 245 files and 5000 results", () => {
    const model = buildExpandSearchRows(makeGroups(245, 5000), {});

    expect(model.rows).toHaveLength(5245);
    expect(model.totalHeight).toBeGreaterThan(100_000);
    expect(model.rows[0].top).toBe(0);
    for (let index = 1; index < model.rows.length; index++) {
      const previous = model.rows[index - 1];
      expect(model.rows[index].top).toBe(previous.top + previous.height);
    }
    const last = model.rows.at(-1)!;
    expect(last.top + last.height).toBe(model.totalHeight);
  });

  it("covers the viewport after repeated large scrollbar jumps", () => {
    const model = buildExpandSearchRows(makeGroups(245, 5000), {});
    const viewportHeight = 790;
    const maxScrollTop = model.totalHeight - viewportHeight;
    const positions = [
      0,
      maxScrollTop,
      maxScrollTop * 0.13,
      maxScrollTop * 0.91,
      maxScrollTop * 0.42,
      maxScrollTop * 0.76,
      maxScrollTop * 0.25,
      maxScrollTop,
      1,
    ];

    for (const scrollTop of positions) {
      const visible = getExpandSearchVisibleRows(model, scrollTop, viewportHeight);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(150);
      expect(visible[0].top).toBeLessThanOrEqual(scrollTop);
      const last = visible.at(-1)!;
      expect(last.top + last.height).toBeGreaterThanOrEqual(
        Math.min(model.totalHeight, scrollTop + viewportHeight),
      );
    }
  });

  it("clamps out-of-range offsets and never returns a blank window", () => {
    const model = buildExpandSearchRows(makeGroups(245, 5000), {});
    for (const scrollTop of [-100_000, Number.MAX_SAFE_INTEGER]) {
      const visible = getExpandSearchVisibleRows(model, scrollTop, 790);
      expect(visible.length).toBeGreaterThan(0);
    }
  });

  it("keeps heavy single-file groups collapsed until explicitly expanded", () => {
    const groups = makeGroups(1, 200);
    const collapsedModel = buildExpandSearchRows(groups, {});
    const expandedModel = buildExpandSearchRows(groups, { [groups[0].path]: false });

    expect(collapsedModel.rows).toHaveLength(1);
    expect(expandedModel.rows).toHaveLength(201);
  });

  it("covers every viewport while scrolling through an expanded 200-result file", () => {
    const groups = makeGroups(1, 200);
    const model = buildExpandSearchRows(groups, { [groups[0].path]: false });
    for (let scrollTop = 0; scrollTop < model.totalHeight; scrollTop += 137) {
      const visible = getExpandSearchVisibleRows(model, scrollTop, 790);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible[0].top).toBeLessThanOrEqual(scrollTop);
      const last = visible.at(-1)!;
      expect(last.top + last.height).toBeGreaterThanOrEqual(
        Math.min(model.totalHeight, scrollTop + 790),
      );
    }
  });

  it("limits rendered text around matches on very long lines", () => {
    const match: ExpandSearchResult = {
      path: "long.min.js",
      name: "long.min.js",
      relPath: "long.min.js",
      dirPath: "",
      lineNumber: 1,
      preview: `${"a".repeat(20_000)}match${"z".repeat(20_000)}`,
      matchStart: 20_000,
      matchEnd: 20_005,
    };

    const preview = getExpandSearchPreviewParts(match);
    expect(preview.before).toHaveLength(160);
    expect(preview.matched).toBe("match");
    expect(preview.after).toHaveLength(160);
    expect(preview.truncatedBefore).toBe(true);
    expect(preview.truncatedAfter).toBe(true);
  });
});
