/**
 * bash 工具的自动批准规则（设置里「自动批准的命令」）。
 *
 * 只做前缀匹配，但必须挡住命令拼接：规则 "npm test" 绝不能顺带批准
 * "npm test; rm -rf /"。所以前缀之后只允许空白 + 参数，且参数里不能出现
 * 分号、管道、重定向、命令替换等元字符。
 */

import { readFileSync, statSync } from "fs";
import { join } from "path";

const CACHE_TTL_MS = 3000;
const MAX_RULES = 200;
const SHELL_META = /[;&|<>$`\n\r]/;

let cache = { at: 0, rules: [] };

export function parseAutoApproveRules(settings) {
  const raw = settings?.autoApproveCommands;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const rules = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const rule = entry.trim();
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    rules.push(rule);
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

export function isAutoApprovedCommand(rules, command) {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text || !Array.isArray(rules) || rules.length === 0) return false;
  return rules.some((rule) => {
    if (!text.startsWith(rule)) return false;
    const rest = text.slice(rule.length);
    if (!rest) return true;
    if (!/^\s/.test(rest)) return false;
    return !SHELL_META.test(rest);
  });
}

/** 读 settings.json 里的规则；3 秒内复用，避免每次工具调用都读盘。 */
export function loadAutoApproveRules(dataDir, now = Date.now()) {
  const base = typeof dataDir === "string" ? dataDir.trim() : "";
  if (!base) return [];
  const settingsPath = join(base, "settings.json");
  try {
    const mtime = statSync(settingsPath).mtimeMs;
    if (cache.mtime === mtime && now - cache.at < CACHE_TTL_MS) return cache.rules;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    cache = { at: now, mtime, rules: parseAutoApproveRules(parsed) };
    return cache.rules;
  } catch {
    cache = { at: now, mtime: -1, rules: [] };
    return [];
  }
}

export function resetAutoApproveRulesCache() {
  cache = { at: 0, mtime: -1, rules: [] };
}
