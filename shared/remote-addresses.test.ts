import { describe, expect, it } from "vitest";
import {
  buildRemoteCandidateUrls,
  createRemotePairingUri,
  isLikelyLanRemoteUrl,
  normalizeRemoteBaseUrl,
} from "./remote-addresses";

describe("remote connection addresses", () => {
  it("keeps LAN addresses ahead of private VPN and advertised addresses", () => {
    expect(buildRemoteCandidateUrls("100.64.0.17", ["100.64.0.17", "192.168.1.20"], 47831)).toEqual([
      "http://192.168.1.20:47831",
      "http://100.64.0.17:47831",
    ]);
  });

  it("normalizes safe URLs and distinguishes LAN from a mesh VPN", () => {
    expect(normalizeRemoteBaseUrl("http://192.168.1.20:47831/path?q=1")).toBe("http://192.168.1.20:47831");
    expect(isLikelyLanRemoteUrl("http://192.168.1.20:47831")).toBe(true);
    expect(isLikelyLanRemoteUrl("http://100.64.0.17:47831")).toBe(false);
    expect(() => normalizeRemoteBaseUrl("http://8.8.8.8:47831")).toThrow("limited to LAN");
  });

  it("keeps the legacy primary URL while adding repeated smart candidates", () => {
    const pairingUri = createRemotePairingUri({
      version: 1,
      primaryUrl: "http://100.64.0.17:47831",
      candidateUrls: ["http://192.168.1.20:47831", "http://100.64.0.17:47831"],
      pairingId: "pair-1",
      secret: "secret-1",
    });
    const url = new URL(pairingUri);
    expect(url.searchParams.get("url")).toBe("http://100.64.0.17:47831");
    expect(url.searchParams.getAll("candidate")).toEqual([
      "http://192.168.1.20:47831",
      "http://100.64.0.17:47831",
    ]);
  });
});
