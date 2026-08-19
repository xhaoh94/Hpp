import React from "react";
import ReactDOM from "react-dom/client";
import {
  ExpandSearchList,
  type ExpandSearchGroup,
  type ExpandSearchResult,
} from "./components/editor/ExpandSearchList";
import "./index.css";
import "./components/editor/EditorArea.css";

function makeGroups(fileCount: number, resultCount: number): ExpandSearchGroup[] {
  const groups: ExpandSearchGroup[] = Array.from({ length: fileCount }, (_, fileIndex) => ({
    path: `C:\\project\\file-${fileIndex}.ts`,
    name: `file-${fileIndex}.ts`,
    relPath: `src\\file-${fileIndex}.ts`,
    dirPath: "src",
    matches: [],
  }));
  const longPrefix = "a".repeat(20_000);
  const longSuffix = "z".repeat(20_000);
  for (let index = 0; index < resultCount; index++) {
    // 第一个文件集中 200 条，并使用超长行，覆盖实际卡顿数据分布；其余结果分散。
    const group = index < 200
      ? groups[0]
      : groups[1 + ((index - 200) % Math.max(1, groups.length - 1))];
    const longPreview = `${longPrefix}match${longSuffix}`;
    const match: ExpandSearchResult = {
      path: group.path,
      name: group.name,
      relPath: group.relPath,
      dirPath: group.dirPath,
      lineNumber: index + 1,
      preview: index < 200 ? longPreview : `export const result_${index} = "match";`,
      matchStart: index < 200 ? longPrefix.length : 31,
      matchEnd: index < 200 ? longPrefix.length + 5 : 36,
    };
    group.matches.push(match);
  }
  return groups;
}

const groups = makeGroups(245, 5000);

document.documentElement.dataset.theme = "dark";
document.body.style.margin = "0";
document.body.style.height = "100vh";
document.body.style.background = "#181818";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", flexDirection: "column", width: 660, height: 820 }}>
    <div className="editor-expand-search-header" style={{ flex: "0 0 auto" }}>
      <span className="editor-expand-search-title">245 个文件中有 5000 个结果</span>
    </div>
    <ExpandSearchList
      groups={groups}
      replaceOpen={false}
      replaceQuery=""
      preserveCase={false}
      onGoto={() => undefined}
      onReplace={() => undefined}
    />
  </div>,
);
