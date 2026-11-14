import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  isAutoApprovedCommand,
  loadAutoApproveRules,
  parseAutoApproveRules,
  resetAutoApproveRulesCache,
} from "./permission-rules.mjs";

describe("auto approve rules", () => {
  it("drops blanks, duplicates and non-strings", () => {
    expect(parseAutoApproveRules({
      autoApproveCommands: [" npm test ", "", 42, "npm test", "git status"],
    })).toEqual(["npm test", "git status"]);
    expect(parseAutoApproveRules({})).toEqual([]);
    expect(parseAutoApproveRules(null)).toEqual([]);
  });

  it("matches a prefix with arguments", () => {
    const rules = ["npm test", "git status"];
    expect(isAutoApprovedCommand(rules, "npm test")).toBe(true);
    expect(isAutoApprovedCommand(rules, "npm test --watch")).toBe(true);
    expect(isAutoApprovedCommand(rules, "  git status  ")).toBe(true);
    expect(isAutoApprovedCommand(rules, "npm run build")).toBe(false);
  });

  it("rejects command chaining and redirection", () => {
    const rules = ["npm test"];
    expect(isAutoApprovedCommand(rules, "npm test; rm -rf /")).toBe(false);
    expect(isAutoApprovedCommand(rules, "npm test && rm -rf /")).toBe(false);
    expect(isAutoApprovedCommand(rules, "npm test | tee out.log")).toBe(false);
    expect(isAutoApprovedCommand(rules, "npm test > out.log")).toBe(false);
    expect(isAutoApprovedCommand(rules, "npm test $(whoami)")).toBe(false);
    // 没有空白分隔的续写属于另一个命令名。
    expect(isAutoApprovedCommand(rules, "npm testing")).toBe(false);
  });

  it("reads rules from settings.json and caches by mtime", () => {
    resetAutoApproveRulesCache();
    const dir = mkdtempSync(join(tmpdir(), "hpp-perm-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoApproveCommands: ["ls"] }), "utf8");
    expect(loadAutoApproveRules(dir)).toEqual(["ls"]);
    expect(isAutoApprovedCommand(loadAutoApproveRules(dir), "ls -la")).toBe(true);

    writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoApproveCommands: ["pwd"] }), "utf8");
    expect(loadAutoApproveRules(dir, Date.now() + 5000)).toEqual(["pwd"]);
  });

  it("returns no rules when the file is missing", () => {
    resetAutoApproveRulesCache();
    expect(loadAutoApproveRules(join(tmpdir(), "hpp-perm-missing-dir"))).toEqual([]);
    expect(loadAutoApproveRules("")).toEqual([]);
  });
});
