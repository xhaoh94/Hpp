import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const mobileOnlyDependencies = [
  "@aparajita/capacitor-secure-storage",
  "@capacitor-mlkit/barcode-scanning",
  "@capacitor/android",
  "@capacitor/app",
  "@capacitor/camera",
  "@capacitor/core",
];

describe("desktop packaging", () => {
  const packageMetadata = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    build?: { nsis?: { include?: string } };
  };

  it("keeps mobile-only packages out of desktop production dependencies", () => {
    for (const dependency of mobileOnlyDependencies) {
      expect(packageMetadata.dependencies?.[dependency]).toBeUndefined();
      expect(packageMetadata.devDependencies?.[dependency]).toBeTypeOf("string");
    }
  });

  it("includes the legacy long-path upgrade cleanup", () => {
    expect(packageMetadata.build?.nsis?.include).toBe("build/installer.nsh");

    const installerInclude = readFileSync(
      resolve(process.cwd(), "build/installer.nsh"),
      "utf8",
    );
    expect(installerInclude).toContain("capacitor-secure-storage\\android\\build");
    expect(installerInclude).toContain("@capacitor\\android\\capacitor\\build");
  });
});
