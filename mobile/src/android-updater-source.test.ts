import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Android updater native integration", () => {
  it("declares install permission and registers the Capacitor plugin", () => {
    const manifest = readWorkspaceFile("mobile/android/app/src/main/AndroidManifest.xml");
    const mainActivity = readWorkspaceFile("mobile/android/app/src/main/java/com/hpp/mobile/MainActivity.java");

    expect(manifest).toContain("android.permission.REQUEST_INSTALL_PACKAGES");
    expect(mainActivity).toContain("registerPlugin(HppUpdaterPlugin.class)");
  });

  it("verifies the APK before opening it through FileProvider", () => {
    const plugin = readWorkspaceFile("mobile/android/app/src/main/java/com/hpp/mobile/HppUpdaterPlugin.java");

    expect(plugin).toContain('MessageDigest.getInstance("SHA-256")');
    expect(plugin).toContain("MessageDigest.isEqual");
    expect(plugin).toContain("FileProvider.getUriForFile");
    expect(plugin).toContain("FLAG_GRANT_READ_URI_PERMISSION");
    expect(plugin).toContain('Uri.parse("package:" + getContext().getPackageName())');
  });

  it("keeps release metadata wired into the streaming GitHub publisher", () => {
    const buildScript = readWorkspaceFile("scripts/build-android-release.ps1");
    const publishScript = readWorkspaceFile("scripts/reset-github-release.cjs");

    expect(buildScript).toContain('"android-latest.json"');
    expect(buildScript).toContain("Get-FileHash $releaseApk -Algorithm SHA256");
    expect(publishScript).toContain("createReadStream(filePath)");
    expect(publishScript).toContain('join(releaseDir, "android-latest.json")');
  });
});
