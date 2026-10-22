import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalMediaServer, type LocalMediaServer } from "./local-media-server";

describe("local media server", () => {
  let root = "";
  let file = "";
  let server: LocalMediaServer | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-media-"));
    file = join(root, "clip.mp4");
    await writeFile(file, Buffer.from("0123456789"));
    server = await createLocalMediaServer();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await rm(root, { recursive: true, force: true });
  });

  it("serves the whole file with a video content type", async () => {
    const response = await fetch(`${server!.baseUrl}${encodeURIComponent(file)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("0123456789");
  });

  it("supports byte ranges so the player can seek", async () => {
    const response = await fetch(`${server!.baseUrl}${encodeURIComponent(file)}`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  });

  it("rejects wrong tokens, missing files and directories", async () => {
    const wrongTokenBase = server!.baseUrl.replace(/\/media\/[^/]+\//, "/media/wrong-token/");
    expect((await fetch(`${wrongTokenBase}${encodeURIComponent(file)}`)).status).toBe(403);
    expect((await fetch(`${server!.baseUrl}${encodeURIComponent(join(root, "missing.mp4"))}`)).status).toBe(404);
    expect((await fetch(`${server!.baseUrl}${encodeURIComponent(root)}`)).status).toBe(404);
  });
});
