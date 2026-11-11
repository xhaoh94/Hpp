import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("backgroundable Android update download", () => {
  it("lets the user dismiss the dialog while the download is running", () => {
    const app = readWorkspaceFile("mobile/src/App.tsx");

    expect(app).toContain('const busy = stage === "checking"');
    expect(app).not.toContain('stage === "checking" || stage === "downloading"');
    expect(app).toContain('? "后台下载"');
  });

  it("keeps polling without reopening the dialog or auto-installing in background mode", () => {
    const app = readWorkspaceFile("mobile/src/App.tsx");

    expect(app).toContain("const background = updateBackgroundRef.current");
    expect(app).toContain("installWhenDownloaded && !background");
    expect(app).toContain("applyAndroidDownloadStatus(status, !background)");
    expect(app).toContain("if (!background) setUpdateDialogOpen(true)");
    expect(app).toContain('updateStage !== "downloading"');
  });

  it("offers a progress pill and a way back into the dialog", () => {
    const app = readWorkspaceFile("mobile/src/App.tsx");

    expect(app).toContain("<AndroidUpdatePill stage={updateStage} progress={updateProgress} onOpen={reopenUpdateDialog} />");
    expect(app).toContain("function AndroidUpdatePill(");
    expect(app).toContain('"更新已下载，点击安装"');
    expect(app).toContain("setUpdateBackground(false)");
  });

  it("keeps native downloads alive outside the WebView with a completion notice", () => {
    const plugin = readWorkspaceFile("mobile/android/app/src/main/java/com/hpp/mobile/HppUpdaterPlugin.java");

    expect(plugin).toContain("DownloadManager.Request");
    expect(plugin).toContain("VISIBILITY_VISIBLE_NOTIFY_COMPLETED");
    expect(plugin).toContain("setDestinationInExternalFilesDir");
  });
});
