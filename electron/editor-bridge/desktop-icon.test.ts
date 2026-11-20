import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { parseDesktopIcon, resolveIconValue } from "./desktop-icon";

describe("parseDesktopIcon", () => {
  it("reads the Icon= field and ignores comments and other keys", () => {
    const content = [
      "[Desktop Entry]",
      "# Icon=comment-icon",
      "Name=Visual Studio Code",
      "Exec=/usr/share/code/code %F",
      "Icon=code",
      "Type=Application",
    ].join("\n");
    expect(parseDesktopIcon(content)).toBe("code");
  });

  it("returns null when Icon= is missing or empty", () => {
    expect(parseDesktopIcon("[Desktop Entry]\nName=Code\n")).toBeNull();
    expect(parseDesktopIcon("[Desktop Entry]\nIcon=\n")).toBeNull();
  });

  it("is case-insensitive on the key", () => {
    expect(parseDesktopIcon("ICON=zed\n")).toBe("zed");
  });
});

describe("resolveIconValue", () => {
  it("accepts an existing absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-icon-"));
    const icon = join(dir, "code.png");
    writeFileSync(icon, "");
    expect(resolveIconValue(icon)).toBe(icon);
  });

  it("returns null for a missing absolute path", () => {
    expect(resolveIconValue("/no/such/icon/path.png")).toBeNull();
  });
});
