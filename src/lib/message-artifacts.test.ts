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

  it("系统临时目录里的文件不算产物", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "w1", type: "tool", files: [{ file: "/tmp/rel_apply2.txt", action: "written" }] },
      { id: "w2", type: "tool", files: [{ file: "C:\\Users\\x\\AppData\\Local\\Temp\\shot.png", action: "written" }] },
      { id: "w3", type: "tool", files: [{ file: "/var/tmp/out.pdf", action: "written" }] },
      { id: "w4", type: "tool", files: [{ file: "C:/proj/release/hpp.exe", action: "written" }] },
    ]));

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["hpp.exe"]);
  });

  it("依赖与缓存目录里的文件不算产物", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "w1", type: "tool", files: [{ file: "C:/proj/node_modules/pkg/logo.png", action: "written" }] },
      { id: "w2", type: "tool", files: [{ file: "C:/proj/.cache/build/report.pdf", action: "written" }] },
      { id: "w3", type: "tool", files: [{ file: "C:/proj/__pycache__/x.csv", action: "written" }] },
      { id: "w4", type: "tool", files: [{ file: "C:/proj/docs/report.pdf", action: "written" }] },
    ]));

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["report.pdf"]);
  });

  it("工作区自带的 tmp/.tmp 草稿不算产物，工作区外的成品照收", () => {
    const artifacts = collectMessageArtifacts(
      message([
        { id: "w1", type: "tool", files: [{ file: "C:/proj/tmp/demo.html", action: "written" }] },
        { id: "w2", type: "tool", files: [{ file: "C:/proj/.tmp/probe.png", action: "written" }] },
        { id: "w3", type: "tool", files: [{ file: "C:/proj/dist/site/index.html", action: "written" }] },
        // 目录名只是前缀相同，不是 tmp 本身。
        { id: "w4", type: "tool", files: [{ file: "C:/proj/tmpdata/report.md", action: "written" }] },
        { id: "w5", type: "tool", files: [{ file: "C:/Users/x/Desktop/报告.docx", action: "written" }] },
      ]),
      { workspacePath: "C:\\proj" },
    );

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["index.html", "report.md", "报告.docx"]);
  });

  it("写过又被删掉的文件不算产物", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "w", type: "tool", files: [{ file: "C:/proj/out.png", action: "written" }] },
      { id: "d", type: "tool", files: [{ file: "C:/proj/out.png", action: "deleted" }] },
      { id: "d2", type: "diff", files: [{ file: "C:/proj/old.pdf", status: "deleted" }] },
      { id: "w2", type: "tool", files: [{ file: "C:/proj/keep.zip", action: "written" }] },
    ]));

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["keep.zip"]);
  });

  it("模型显式声明的产物不受扩展名和位置限制", () => {
    const artifacts = collectMessageArtifacts(
      message([
        // 声明优先：/tmp 里的成品、脚本类交付物都算。
        { id: "p", type: "tool", toolKind: "unknown", files: [{ file: "/tmp/report.txt", action: "presented" }] },
        { id: "p2", type: "tool", toolKind: "unknown", files: [{ file: "C:/proj/tools/run.sh", action: "presented" }] },
        // 没声明的一律按推断规则，仍然被 /tmp 过滤掉。
        { id: "w", type: "tool", files: [{ file: "/tmp/scratch.txt", action: "written" }] },
      ]),
      { workspacePath: "C:/proj" },
    );

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["report.txt", "run.sh"]);
  });

  it("收 Office 老格式", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "w1", type: "tool", files: [{ file: "C:/proj/a.doc", action: "written" }] },
      { id: "w2", type: "tool", files: [{ file: "C:/proj/b.xls", action: "written" }] },
      { id: "w3", type: "tool", files: [{ file: "C:/proj/c.ppt", action: "written" }] },
    ]));

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["document", "document", "document"]);
  });
});
