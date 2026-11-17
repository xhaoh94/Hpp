import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatOpDuration } from "./GitOpLogDialog";

describe("operation log duration formatting", () => {
  it("always uses seconds with the same precision", () => {
    expect(formatOpDuration(undefined)).toBe("");
    expect(formatOpDuration(598)).toBe("0.598s");
    expect(formatOpDuration(24_253)).toBe("24.253s");
    expect(formatOpDuration(1_000)).toBe("1.000s");
    expect(formatOpDuration(123_456)).toBe("123.456s");
  });

  it("aligns time and duration into fixed-width columns", () => {
    const dialog = readFileSync(resolve(process.cwd(), "src/components/git/GitOpLogDialog.tsx"), "utf8");
    expect(dialog).toContain('className="git-log-time"');
    expect(dialog).toContain('className="git-log-duration"');

    const styles = readFileSync(resolve(process.cwd(), "src/components/git/GitWorkspaceModal.css"), "utf8");
    expect(styles).toMatch(/\.git-log-meta \.git-log-time\s*\{[^}]*flex:\s*0 0 8ch/s);
    expect(styles).toMatch(/\.git-log-meta \.git-log-duration\s*\{[^}]*flex:\s*0 0 12ch/s);
    expect(styles).toMatch(/\.git-log-meta \.git-log-duration\s*\{[^}]*text-align:\s*right/s);
  });
});
