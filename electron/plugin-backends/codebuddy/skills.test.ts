import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillPrompt,
  parseSkillMarkdown,
  readCodebuddySkills,
  toCodebuddyActionCatalog,
} from "./skills";

const tempDirs: string[] = [];

const createTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hpp-codebuddy-skills-"));
  tempDirs.push(dir);
  return dir;
};

const writeSkill = (root: string, dirName: string, content: string) => {
  const dir = join(root, ".codebuddy", "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
};

const writeBuiltin = (home: string, skills: unknown[]) => {
  const dir = join(home, ".codebuddy", "local_storage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "entry-codebuddy.info"),
    JSON.stringify({ productName: "CodeBuddy", skills }),
    "utf8",
  );
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("parseSkillMarkdown", () => {
  it("解析 frontmatter 与正文", () => {
    const skill = parseSkillMarkdown([
      "---",
      "name: deploy-check",
      "description: 检查部署状态",
      "argument-hint: <环境>",
      "---",
      "",
      "先看部署状态，再给出结论。",
    ].join("\n"), "fallback");

    expect(skill).toMatchObject({
      name: "deploy-check",
      description: "检查部署状态",
      argumentHint: "<环境>",
      instructions: "先看部署状态，再给出结论。",
    });
  });

  it("没有 frontmatter 或没有 name 时不当作技能", () => {
    expect(parseSkillMarkdown("# 普通说明\n内容")).toBeNull();
    expect(parseSkillMarkdown("---\ndescription: 只有描述\n---\n正文")).toBeNull();
  });
});

describe("readCodebuddySkills", () => {
  it("合并项目级、用户级与服务端下发技能，同名按项目优先", () => {
    const home = createTempDir();
    const project = createTempDir();

    writeSkill(home, "shared", "---\nname: shared\ndescription: 用户级\n---\n用户正文");
    writeSkill(home, "user-only", "---\nname: user-only\ndescription: 仅用户级\n---\n用户正文");
    writeSkill(project, "shared", "---\nname: shared\ndescription: 项目级\n---\n项目正文");
    writeSkill(project, "project-only", "---\nname: project-only\ndescription: 仅项目级\n---\n项目正文");
    writeBuiltin(home, [
      { name: "loop", description: "重复执行", instructions: "按间隔重复" },
      { name: "shared", description: "内置同名" },
    ]);

    const skills = readCodebuddySkills(project, home);
    expect(skills.map((skill) => [skill.name, skill.source])).toEqual([
      ["project-only", "project"],
      ["shared", "project"],
      ["user-only", "user"],
      ["loop", "builtin"],
    ]);
    expect(skills.find((skill) => skill.name === "shared")?.description).toBe("项目级");
  });

  it("没有任何技能时返回空列表", () => {
    const home = createTempDir();
    const project = createTempDir();
    expect(readCodebuddySkills(project, home)).toEqual([]);
    expect(toCodebuddyActionCatalog([])).toEqual([]);
  });

  it("服务端下发的技能名去掉前导斜杠", () => {
    const home = createTempDir();
    writeBuiltin(home, [{ name: "/loop", description: "重复执行" }]);
    expect(readCodebuddySkills(createTempDir(), home).map((skill) => skill.name)).toEqual(["loop"]);
  });
});

describe("buildSkillPrompt", () => {
  it("把技能正文和用户输入拼成一轮指令", () => {
    const prompt = buildSkillPrompt({
      name: "loop",
      instructions: "按间隔重复运行。",
      source: "builtin",
    }, "5m 检查部署");
    expect(prompt).toContain("使用「loop」技能");
    expect(prompt).toContain("按间隔重复运行。");
    expect(prompt).toContain("用户输入：\n5m 检查部署");
  });

  it("没有用户输入时只带技能说明", () => {
    const prompt = buildSkillPrompt({ name: "loop", instructions: "按间隔重复。", source: "builtin" }, "  ");
    expect(prompt).toBe("使用「loop」技能完成本轮请求。\n\n按间隔重复。");
  });
});

describe("toCodebuddyActionCatalog", () => {
  it("只保留动作面板需要的字段", () => {
    expect(toCodebuddyActionCatalog([{
      name: "loop",
      description: "重复执行",
      argumentHint: "<间隔>",
      instructions: "正文",
      source: "builtin",
    }])).toEqual([{
      kind: "skill",
      name: "loop",
      description: "重复执行",
      argumentHint: "<间隔>",
    }]);
  });
});
