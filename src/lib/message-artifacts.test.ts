import { describe, expect, it } from "vitest";
import { collectMessageArtifacts } from "./message-artifacts";
import type { ChatMessage } from "@/stores/chat-store";

const message = (entries: unknown[]): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content: "",
  timestamp: 1,
  process: { startedAt: 1, expanded: true, entries: entries as never },
});

describe("collectMessageArtifacts", () => {
  it("代码文件不算产物（留给 diff 面板）", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "c", type: "tool", toolKind: "write_file", files: [{ file: "src/new-module.ts", action: "written" }] },
      { id: "p", type: "tool", toolKind: "write_file", files: [{ file: "release/hpp.apk", action: "written" }] },
    ]));
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["hpp.apk"]);
  });

  it("只收集写入类动作与 diff 条目，忽略查看", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "r", type: "tool", toolKind: "read_file", files: [{ file: "C:/p/viewed.cs", action: "read" }] },
      { id: "w", type: "tool", toolKind: "write_file", files: [{ file: "C:/p/made.png", action: "written" }] },
      { id: "d", type: "diff", files: [{ file: "C:/p/bundle.zip" }] },
      { id: "t", type: "thinking", title: "思考" },
    ]));

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["made.png", "bundle.zip"]);
    expect(artifacts[0].kind).toBe("image");
    expect(artifacts[1].kind).toBe("file");
  });

  it("按路径去重，并识别网页文档", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "w1", type: "tool", files: [{ file: "C:/p/page.html", action: "written" }] },
      { id: "w2", type: "tool", files: [{ file: "c:/p/page.html", action: "edited" }] },
    ]));

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("document");
  });

  it("跳过已经在 diff 面板里展示过的文件（含相对/绝对路径混用）", () => {
    const artifacts = collectMessageArtifacts(
      message([
        { id: "d", type: "diff", files: [{ file: "dist/report.pdf" }] },
        { id: "w", type: "tool", files: [{ file: "C:/proj/dist/bundle.zip", action: "written" }] },
      ]),
      { excludePaths: ["C:\\proj\\dist\\report.pdf"] },
    );

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["bundle.zip"]);
  });

  it("没有产出时返回空数组", () => {
    expect(collectMessageArtifacts(message([{ id: "t", type: "thinking", title: "思考" }]))).toEqual([]);
    expect(collectMessageArtifacts({ id: "m", role: "assistant", content: "", timestamp: 1 })).toEqual([]);
  });
});
