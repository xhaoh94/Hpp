export function isPrivateHttpHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254);
}

export function normalizeRemoteBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// or https:// desktop addresses are supported.");
  }
  if (url.protocol === "http:" && !isPrivateHttpHost(url.hostname)) {
    throw new Error("Unencrypted connections are limited to LAN, localhost, and private VPN addresses.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function isLikelyLanRemoteUrl(baseUrl: string) {
  try {
    const host = new URL(normalizeRemoteBaseUrl(baseUrl)).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "::1" || host.startsWith("fe80:")) return true;
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
    return parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254);
  } catch {
    return false;
  }
}

export function uniqueRemoteBaseUrls(values: Iterable<string>) {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    try {
      const normalized = normalizeRemoteBaseUrl(value);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      // Ignore unusable interface addresses while retaining valid candidates.
    }
  }
  return urls;
}

export function formatRemoteOrigin(address: string, port: number) {
  const normalized = address.trim() || "127.0.0.1";
  if (/^https?:\/\//i.test(normalized)) return normalized.replace(/\/$/, "");
  const host = normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
  return `http://${host}:${port}`;
}

export function buildRemoteCandidateUrls(advertiseAddress: string, addresses: string[], port: number) {
  const detected = uniqueRemoteBaseUrls(addresses.map((address) => formatRemoteOrigin(address, port)));
  const local = detected.filter(isLikelyLanRemoteUrl);
  const other = detected.filter((url) => !isLikelyLanRemoteUrl(url));
  return uniqueRemoteBaseUrls([
    ...local,
    ...other,
    formatRemoteOrigin(advertiseAddress, port),
  ]);
}

export function createRemotePairingUri(input: {
  version: number;
  primaryUrl: string;
  candidateUrls: string[];
  pairingId: string;
  secret: string;
}) {
  const url = new URL("hpp://pair");
  url.searchParams.set("v", String(input.version));
  url.searchParams.set("url", input.primaryUrl);
  for (const candidate of uniqueRemoteBaseUrls(input.candidateUrls)) {
    url.searchParams.append("candidate", candidate);
  }
  url.searchParams.set("pairingId", input.pairingId);
  url.searchParams.set("secret", input.secret);
  return url.toString();
}
