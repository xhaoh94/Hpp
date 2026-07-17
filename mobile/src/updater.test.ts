import { describe, expect, it } from "vitest";
import {
  getAndroidUpdateErrorMessage,
  isAndroidUpdateAvailable,
  parseGitHubReleaseUpdateMetadata,
  parseAndroidUpdateMetadata,
} from "./updater";

const metadata = {
  version: "0.1.3",
  versionCode: 103,
  url: "https://github.com/xhaoh94/Hpp/releases/latest/download/Hpp-Android.apk",
  sha256: "a".repeat(64),
  publishedAt: "2026-07-17T00:00:00.000Z",
};

describe("Android updater", () => {
  it("accepts signed HTTPS update metadata", () => {
    expect(parseAndroidUpdateMetadata(JSON.stringify(metadata))).toEqual(metadata);
  });

  it("rejects malformed hashes and non-HTTPS downloads", () => {
    expect(() => parseAndroidUpdateMetadata({ ...metadata, sha256: "short" })).toThrow("UPDATE_METADATA_INVALID");
    expect(() => parseAndroidUpdateMetadata({ ...metadata, url: "http://example.com/app.apk" })).toThrow("UPDATE_METADATA_INVALID");
    expect(() => parseAndroidUpdateMetadata("not-json")).toThrow("UPDATE_METADATA_INVALID");
  });

  it("compares Android versionCode instead of display versions", () => {
    expect(isAndroidUpdateAvailable("102", metadata)).toBe(true);
    expect(isAndroidUpdateAvailable(103, metadata)).toBe(false);
    expect(isAndroidUpdateAvailable(104, metadata)).toBe(false);
  });

  it("builds metadata from the GitHub release API without downloading a manifest asset", () => {
    expect(parseGitHubReleaseUpdateMetadata({
      tag_name: "v0.1.3",
      published_at: "2026-07-17T00:00:00.000Z",
      assets: [{
        name: "Hpp-Android.apk",
        label: "hpp-version-code:103",
        digest: `sha256:${"a".repeat(64)}`,
        browser_download_url: "https://github.com/xhaoh94/Hpp/releases/download/v0.1.3/Hpp-Android.apk",
      }],
    })).toEqual({
      ...metadata,
      url: "https://github.com/xhaoh94/Hpp/releases/download/v0.1.3/Hpp-Android.apk",
    });
  });

  it("rejects GitHub releases that omit the versionCode label or APK digest", () => {
    expect(() => parseGitHubReleaseUpdateMetadata({
      tag_name: "v0.1.3",
      assets: [{ name: "Hpp-Android.apk", digest: `sha256:${"a".repeat(64)}` }],
    })).toThrow("UPDATE_METADATA_INVALID");
  });

  it("maps native failures to concise Chinese messages", () => {
    expect(getAndroidUpdateErrorMessage({ code: "CHECKSUM_MISMATCH" })).toBe("安装包校验失败，请重新下载");
    expect(getAndroidUpdateErrorMessage(new Error("DOWNLOAD_FAILED"))).toBe("安装包下载失败，请检查网络后重试");
    expect(getAndroidUpdateErrorMessage(new Error("UPDATE_CHECK_HTTP_404"))).toBe("无法获取更新信息，请检查网络后重试");
    expect(getAndroidUpdateErrorMessage(new Error("connection closed"))).toBe("无法连接 GitHub，请检查网络或稍后重试");
  });
});
