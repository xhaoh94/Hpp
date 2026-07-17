import { afterEach, describe, expect, it, vi } from "vitest";
import { pairHost, parsePairingUri, probeHostAvailability, resolveHostBaseUrl, withPreferredHostBaseUrl } from "./remote-client";
import type { PairedHost } from "./storage";

const pairingUri = "hpp://pair?v=1&url=http%3A%2F%2F192.168.1.20%3A47831&pairingId=pair-1&secret=abcdefghijklmnopqrstuvwxyz123456";

describe("remote client pairing links", () => {
  it("parses native Hpp pairing links", () => {
    expect(parsePairingUri(pairingUri)).toEqual({
      baseUrl: "http://192.168.1.20:47831",
      baseUrls: ["http://192.168.1.20:47831"],
      pairingId: "pair-1",
      secret: "abcdefghijklmnopqrstuvwxyz123456",
    });
  });

  it("parses universal Web pairing links", () => {
    const webUrl = `http://192.168.1.20:47831/?pair=${encodeURIComponent(pairingUri)}`;
    expect(parsePairingUri(webUrl)).toEqual({
      baseUrl: "http://192.168.1.20:47831",
      baseUrls: ["http://192.168.1.20:47831"],
      pairingId: "pair-1",
      secret: "abcdefghijklmnopqrstuvwxyz123456",
    });
  });

  it("accepts Android clipboard wrappers, zero-width characters, and HTML ampersands", () => {
    const wrapped = `Hpp 配对链接：\n\u200Bhttp://100.64.0.17:47831/?pair=${encodeURIComponent(pairingUri).replace(/&/g, "&amp;")}\n`;
    expect(parsePairingUri(wrapped)).toEqual({
      baseUrl: "http://192.168.1.20:47831",
      baseUrls: ["http://192.168.1.20:47831"],
      pairingId: "pair-1",
      secret: "abcdefghijklmnopqrstuvwxyz123456",
    });
  });

  it("accepts a repeatedly encoded pairing payload", () => {
    const webUrl = `http://100.64.0.17:47831/?pair=${encodeURIComponent(encodeURIComponent(pairingUri))}`;
    expect(parsePairingUri(webUrl)).toEqual({
      baseUrl: "http://192.168.1.20:47831",
      baseUrls: ["http://192.168.1.20:47831"],
      pairingId: "pair-1",
      secret: "abcdefghijklmnopqrstuvwxyz123456",
    });
  });

  it("explains when only a connection address was pasted", () => {
    expect(() => parsePairingUri("http://100.64.0.17:47831"))
      .toThrow("当前内容只是连接地址，不是配对链接");
  });
});

describe("saved desktop availability", () => {
  const host: PairedHost = {
    id: "saved-host",
    hostId: "desktop-1",
    hostName: "Studio Desktop",
    baseUrl: "http://192.168.1.20:47831",
    deviceId: "device-1",
    token: "token-1",
  };

  afterEach(() => vi.unstubAllGlobals());

  it("reports the saved desktop online when its health identity matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, protocolVersion: 1, hostId: "desktop-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeHostAvailability(host)).resolves.toBe("online");
    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.20:47831/api/v1/health", expect.objectContaining({ cache: "no-store" }));
  });

  it("does not mark a different desktop at the saved address as online", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, protocolVersion: 1, hostId: "desktop-2" }),
    }));

    await expect(probeHostAvailability(host)).resolves.toBe("offline");
  });

  it("reports an unreachable desktop offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    await expect(probeHostAvailability(host)).resolves.toBe("offline");
  });

  it("prefers a matching LAN address over the saved mesh VPN address", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request) => ({
      ok: true,
      json: async () => ({ ok: true, protocolVersion: 1, hostId: "desktop-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveHostBaseUrl({
      ...host,
      baseUrl: "http://100.64.0.17:47831",
      baseUrls: ["http://100.64.0.17:47831", "http://192.168.1.20:47831"],
    })).resolves.toBe("http://192.168.1.20:47831");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("192.168.1.20");
  });

  it("falls back to the mesh VPN address when LAN is unavailable", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request) => {
      if (String(input).includes("192.168.1.20")) throw new Error("LAN unavailable");
      return {
        ok: true,
        json: async () => ({ ok: true, protocolVersion: 1, hostId: "desktop-1" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveHostBaseUrl({
      ...host,
      baseUrl: "http://100.64.0.17:47831",
      baseUrls: ["http://100.64.0.17:47831", "http://192.168.1.20:47831"],
    })).resolves.toBe("http://100.64.0.17:47831");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps newly discovered addresses when a successful route becomes preferred", () => {
    expect(withPreferredHostBaseUrl(host, "http://192.168.1.30:47831", ["http://100.64.0.17:47831"]))
      .toMatchObject({
        baseUrl: "http://192.168.1.30:47831",
        baseUrls: [
          "http://192.168.1.30:47831",
          "http://100.64.0.17:47831",
          "http://192.168.1.20:47831",
        ],
      });
  });
});

describe("smart pairing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pairs through LAN and stores both LAN and mesh addresses", async () => {
    const smartPairingUri = `hpp://pair?v=1&url=${encodeURIComponent("http://100.64.0.17:47831")}` +
      `&candidate=${encodeURIComponent("http://192.168.1.30:47831")}` +
      `&candidate=${encodeURIComponent("http://100.64.0.17:47831")}` +
      "&pairingId=pair-1&secret=abcdefghijklmnopqrstuvwxyz123456";
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input);
      if (!init?.method) {
        return { ok: true, json: async () => ({ ok: true, protocolVersion: 1, hostId: "desktop-1" }) };
      }
      expect(target).toBe("http://192.168.1.30:47831/api/v1/pair");
      return {
        ok: true,
        json: async () => ({
          ok: true,
          hostId: "desktop-1",
          hostName: "Studio Desktop",
          deviceId: "device-1",
          token: "token-1",
          connectionUrls: ["http://192.168.1.30:47831", "http://100.64.0.17:47831"],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pairHost(smartPairingUri, "Android device")).resolves.toMatchObject({
      hostId: "desktop-1",
      baseUrl: "http://192.168.1.30:47831",
      baseUrls: ["http://192.168.1.30:47831", "http://100.64.0.17:47831"],
    });
  });
});
