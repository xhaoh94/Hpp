import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AgentActionCatalogEntry } from "../../../shared/agent-actions";

/**
 * CodeBuddy 的技能来源（全部来自磁盘/服务端下发，没有内置候选）：
 *
 * 1. 项目级 `<project>/.codebuddy/skills/<name>/SKILL.md`
 * 2. 用户级 `~/.codebuddy/skills/<name>/SKILL.md`
 * 3. CLI 产品配置里服务端下发的 `skills`（`~/.codebuddy/local_storage/*.info`）
 *
 * CLI 的 `/skills` 面板只在交互式 TUI 里渲染，headless 拿不到结构化列表，
 * 所以 Hpp 自己按同一套目录约定读取。
 */
export interface CodebuddySkill {
  name: string;
  description?: string;
  argumentHint?: string;
  /** 技能正文（SKILL.md 的 markdown）或服务端下发的 instructions。 */
  instructions?: string;
  source: "project" | "user" | "builtin";
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_INSTRUCTIONS_CHARS = 20_000;

const asString = (value: unknown): string => (
  typeof value === "string" ? value.trim() : ""
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === "object" && !Array.isArray(value)
);

/** 解析 SKILL.md 的 YAML frontmatter（只认 name / description / argument-hint）。 */
export function parseSkillMarkdown(raw: string, fallbackName = ""): CodebuddySkill | null {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const header = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "").trim();

  const fields: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^["'](.*)["']$/, "$1");
    if (value) fields[match[1].toLowerCase()] = value;
  }

  const name = fields.name || fallbackName;
  if (!name) return null;
  return {
    name,
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields["argument-hint"] ? { argumentHint: fields["argument-hint"] } : {}),
    ...(body ? { instructions: body.slice(0, MAX_INSTRUCTIONS_CHARS) } : {}),
    source: "project",
  };
}

function scanSkillDirectory(root: string, source: "project" | "user"): CodebuddySkill[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: CodebuddySkill[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) continue;
      const parsed = parseSkillMarkdown(readFileSync(file, "utf8"), entry);
      if (parsed) skills.push({ ...parsed, source });
    } catch {
      // 单个技能不可读时跳过，不影响其它技能。
    }
  }
  return skills;
}

function decodeStorageValue(raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  if (typeof value === "string" && value.startsWith("H4sI")) {
    try {
      value = JSON.parse(gunzipSync(Buffer.from(value, "base64")).toString("utf8"));
    } catch {
      return null;
    }
  }
  return value;
}

/** 读服务端下发的技能；多个产品配置时取 CodeBuddy 里技能最多的那份。 */
function readBuiltinSkills(home: string): CodebuddySkill[] {
  const dir = join(home, ".codebuddy", "local_storage");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const configs: Array<{ productName: string; skills: unknown[] }> = [];
  for (const name of names) {
    if (!name.endsWith(".info")) continue;
    let raw = "";
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const value = decodeStorageValue(raw);
    if (!isRecord(value) || !Array.isArray(value.skills) || value.skills.length === 0) continue;
    configs.push({ productName: asString(value.productName), skills: value.skills });
  }
  if (configs.length === 0) return [];

  const codebuddyConfigs = configs.filter((config) => config.productName.toLowerCase() === "codebuddy");
  const pool = codebuddyConfigs.length > 0 ? codebuddyConfigs : configs;
  const config = pool.reduce((best, item) => (item.skills.length > best.skills.length ? item : best), pool[0]);

  return config.skills.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const name = asString(raw.name).replace(/^\//, "");
    if (!name) return [];
    const description = asString(raw.description);
    const instructions = asString(raw.instructions);
    return [{
      name,
      ...(description ? { description } : {}),
      ...(instructions ? { instructions: instructions.slice(0, MAX_INSTRUCTIONS_CHARS) } : {}),
      source: "builtin" as const,
    }];
  });
}

/**
 * 读出当前会话可用的技能。同名技能按 项目 > 用户 > 内置 取胜者，
 * 与 CLI `/skills` 面板的层级覆盖一致。
 */
export function readCodebuddySkills(projectPath: string, home = homedir()): CodebuddySkill[] {
  const seen = new Set<string>();
  const result: CodebuddySkill[] = [];
  const push = (skill: CodebuddySkill) => {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(skill);
  };

  const projectRoot = join(projectPath || process.cwd(), ".codebuddy", "skills");
  for (const skill of scanSkillDirectory(projectRoot, "project")) push(skill);
  for (const skill of scanSkillDirectory(join(home, ".codebuddy", "skills"), "user")) push(skill);
  for (const skill of readBuiltinSkills(home)) push(skill);
  return result;
}

export function toCodebuddyActionCatalog(skills: CodebuddySkill[]): AgentActionCatalogEntry[] {
  return skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  }));
}

/**
 * 把技能说明注入这一轮输入。
 *
 * CLI 的 print 模式不解析 `/skill` 斜杠命令（实测会当普通文本发给模型），
 * 所以只能把技能正文作为本轮指令的一部分，让模型用内置 Skill 工具执行。
 */
export function buildSkillPrompt(skill: CodebuddySkill, message: string): string {
  const text = message.trim();
  const body = skill.instructions?.trim();
  const header = `使用「${skill.name}」技能完成本轮请求。`;
  const sections = [header];
  if (body) sections.push(body);
  if (text) sections.push(`用户输入：\n${text}`);
  return sections.join("\n\n");
}
