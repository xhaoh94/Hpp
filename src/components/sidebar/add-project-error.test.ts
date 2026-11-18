import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeCloneError } from "./ProjectView";

describe("add project error presentation", () => {
  it("extracts the real failure line from git clone progress noise", () => {
    const noisy = [
      "克隆失败：remote: Compressing objects:   1% (1/54)",
      "remote: Compressing objects:  37% (20/54)",
      "fatal: could not read Username for 'https://github.com': No such device or address",
      "remote: Compressing objects:  38% (21/54)",
    ].join("\n");

    expect(summarizeCloneError(noisy)).toBe(
      "fatal: could not read Username for 'https://github.com': No such device or address",
    );
  });

  it("falls back to the last meaningful line, then to a short fixed message", () => {
    expect(summarizeCloneError("一行简单错误")).toBe("一行简单错误");
    expect(summarizeCloneError("")).toBe("克隆失败。");
    expect(summarizeCloneError("remote: Compressing objects: 1% (1/54)")).toBe("克隆失败，请检查仓库地址与网络。");
  });

  it("routes errors to a floating toast and keeps the inline hint to one line", () => {
    const view = readFileSync(resolve(process.cwd(), "src/components/sidebar/ProjectView.tsx"), "utf8");
    expect(view).toContain('showFloatingToastMessage(summarizeCloneError(error), "error")');
    expect(view).toContain("title={addError}");

    const styles = readFileSync(resolve(process.cwd(), "src/components/sidebar/Sidebar.css"), "utf8");
    const inline = styles.slice(styles.indexOf(".add-project-error {"), styles.indexOf("}", styles.indexOf(".add-project-error {")));
    expect(inline).toContain("text-overflow: ellipsis");
    expect(inline).not.toContain("white-space: pre-wrap");

    const button = styles.slice(styles.indexOf(".project-modal .path-input-row > .btn-browse"), styles.indexOf("}", styles.indexOf(".project-modal .path-input-row > .btn-browse")));
    expect(button).toContain("height: 34px");
  });

  it("supports an error tone with a longer display time", () => {
    const toast = readFileSync(resolve(process.cwd(), "src/lib/floating-toast.ts"), "utf8");
    expect(toast).toContain('tone: FloatingToastTone = "success"');
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain('tone === "success" ? 2600 : 5200');
    expect(app).toContain('className={`app-floating-toast tone-${floatingToast.tone}`}');
  });
});
