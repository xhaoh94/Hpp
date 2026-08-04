import { describe, expect, it } from "vitest";
import { findBlockedPlanCommand, isPlanCommandReadOnly } from "./plan-mode-policy.mjs";

describe("Pi Plan mode shell policy", () => {
  it("allows read-only POSIX discovery and Git inspection", () => {
    expect(isPlanCommandReadOnly("rg -n 'planMode' electron | head -20", "bash")).toBe(true);
    expect(isPlanCommandReadOnly("git status --short && git diff --stat", "bash")).toBe(true);
    expect(isPlanCommandReadOnly("git --no-pager log -5", "bash")).toBe(true);
  });

  it("allows read-only PowerShell pipelines", () => {
    expect(isPlanCommandReadOnly(
      "Get-ChildItem -Recurse -Filter *.ts | Select-String -Pattern planMode",
      "powershell",
    )).toBe(true);
    expect(isPlanCommandReadOnly("Get-Content package.json; git status --short", "powershell")).toBe(true);
  });

  it("blocks filesystem writes, shell expansion, redirects, and mutating Git commands", () => {
    expect(findBlockedPlanCommand("rm -rf build", "bash")).toBe("rm -rf build");
    expect(findBlockedPlanCommand("Get-Content a.txt | Set-Content b.txt", "powershell"))
      .toBe("Set-Content b.txt");
    expect(isPlanCommandReadOnly("echo changed > file.txt", "bash")).toBe(false);
    expect(isPlanCommandReadOnly("cat $(find . -name secret)", "bash")).toBe(false);
    expect(isPlanCommandReadOnly("git reset --hard", "bash")).toBe(false);
    expect(isPlanCommandReadOnly("git branch new-branch", "bash")).toBe(false);
  });

  it("fails closed for unknown and malformed commands", () => {
    expect(isPlanCommandReadOnly("", "bash")).toBe(false);
    expect(isPlanCommandReadOnly("custom-inspector --dry-run", "bash")).toBe(false);
    expect(isPlanCommandReadOnly("Get-Content 'unterminated", "powershell")).toBe(false);
  });
});
