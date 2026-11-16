import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("同一文件的相对路径与绝对路径写法只保留一条", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "w1", type: "tool", files: [{ file: "Docs/对接清单.md", action: "written" }] },
      { id: "w2", type: "tool", files: [{ file: "G:/Work/Projects/Pro2/dev/Docs/对接清单.md", action: "written" }] },
    ]));

    expect(artifacts).toHaveLength(1);
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

  it("模型显式声明的产物豁免位置限制，但源码文件即使声明了也不算产物", () => {
    const artifacts = collectMessageArtifacts(
      message([
        // 声明优先：/tmp 里的成品、工作区外的自定义格式都算。
        { id: "p", type: "tool", toolKind: "unknown", files: [{ file: "/tmp/report.txt", action: "presented" }] },
        { id: "p2", type: "tool", toolKind: "unknown", files: [{ file: "C:/proj/tools/payload.dat", action: "presented" }] },
        // 源码 / 工程资源即使被 present_files 声明也归 diff，不进产物。
        { id: "p3", type: "tool", toolKind: "unknown", files: [{ file: "C:/proj/Assets/Lua/GuildWar.lua", action: "presented" }] },
        { id: "p4", type: "tool", toolKind: "unknown", files: [{ file: "C:/proj/Assets/UI/Wnd.prefab", action: "presented" }] },
        { id: "p5", type: "tool", toolKind: "unknown", files: [{ file: "/tmp/run.sh", action: "presented" }] },
        // 没声明的一律按推断规则，仍然被 /tmp 过滤掉。
        { id: "w", type: "tool", files: [{ file: "/tmp/scratch.txt", action: "written" }] },
      ]),
      { workspacePath: "C:/proj" },
    );

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["report.txt", "payload.dat"]);
  });

  it("present_files 声明的一批代码文件不会涌入产物清单", () => {
    const artifacts = collectMessageArtifacts(message([
      { id: "present", type: "tool", toolKind: "unknown", files: [
        { file: "G:/Work/Projects/Pro2/dev/Assets/Lua/Logic/GuildWar/WndGuildwarDefDeploy.lua", action: "presented" },
        { file: "G:/Work/Projects/Pro2/dev/Assets/Lua/Logic/GuildWar/WndGuildwarDefDeployItem.lua", action: "presented" },
        { file: "G:/Work/Projects/Pro2/dev/Assets/Lua/Logic/GuildWar/GuildWarDefine.lua", action: "presented" },
        { file: "G:/Work/Projects/Pro2/dev/Assets/ResourceLib/Prefab/UI/WndGuildwarDefDeploy.prefab", action: "presented" },
        { file: "G:/Work/Projects/Pro2/dev/build/Pro2.apk", action: "presented" },
      ] },
    ]));

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["Pro2.apk"]);
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

describe("present_files 提示词与产物边界一致", () => {
  it("Pi worker 的注入提示词明确排除源码与工程资源", () => {
    const worker = readFileSync(
      resolve(process.cwd(), "electron/plugin-backends/pi/worker.mjs"),
      "utf8",
    );
    const guidance = worker.slice(
      worker.indexOf("const PRESENT_FILES_GUIDANCE"),
      worker.indexOf("const isRecord", worker.indexOf("const PRESENT_FILES_GUIDANCE")),
    );
    expect(guidance).toContain("代码与工程资源文件");
    expect(guidance).toContain("不算产物");
    expect(guidance).toContain("diff/改动面板");
  });
});
