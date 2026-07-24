import { get as httpsGet } from "https";

function getRegistryBaseUrls(): string[] {
  const configured = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  return Array.from(new Set([
    configured,
    "https://registry.npmjs.org/",
    "https://registry.npmmirror.com/",
  ].filter(Boolean).map((registry) => registry!.endsWith("/") ? registry! : `${registry}/`)));
}

function getNpmRegistryPackageUrls(packageName: string): string[] {
  const packagePath = `${encodeURIComponent(packageName)}/latest`;
  return getRegistryBaseUrls().map((registry) => new URL(packagePath, registry).toString());
}

function getNpmRegistryMetadataUrls(packageName: string): string[] {
  const packagePath = encodeURIComponent(packageName);
  return getRegistryBaseUrls().map((registry) => new URL(packagePath, registry).toString());
}

export interface NpmPackageVersionInfo {
  latestVersion?: string;
  distTags: Record<string, string>;
  versions: string[];
}

function requestLatestPackageVersion(url: string, timeout = 15000): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Hpp",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          const redirectUrl = new URL(response.headers.location, url).toString();
          response.resume();
          requestLatestPackageVersion(redirectUrl, timeout).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`npm registry returned HTTP ${response.statusCode || "unknown"}`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { version?: unknown };
            resolve(typeof parsed.version === "string" ? parsed.version : undefined);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    request.setTimeout(timeout, () => request.destroy(new Error("npm registry request timed out")));
    request.on("error", reject);
  });
}

export async function getLatestNpmPackageVersion(packageName: string): Promise<string | undefined> {
  let lastError: unknown;
  for (const url of getNpmRegistryPackageUrls(packageName)) {
    try {
      return await requestLatestPackageVersion(url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export async function getNpmPackageVersionInfo(packageName: string): Promise<NpmPackageVersionInfo> {
  let lastError: unknown;
  for (const url of getNpmRegistryMetadataUrls(packageName)) {
    try {
      const result = await new Promise<NpmPackageVersionInfo>((resolve, reject) => {
        const request = httpsGet(url, { headers: { Accept: "application/json", "User-Agent": "Hpp" } }, (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`npm registry returned HTTP ${response.statusCode || "unknown"}`));
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            try {
              const value = JSON.parse(body) as { "dist-tags"?: unknown; versions?: unknown };
              const distTags = value["dist-tags"] && typeof value["dist-tags"] === "object" && !Array.isArray(value["dist-tags"])
                ? Object.fromEntries(Object.entries(value["dist-tags"] as Record<string, unknown>)
                  .filter(([, version]) => typeof version === "string")) as Record<string, string>
                : {};
              const versions = value.versions && typeof value.versions === "object" && !Array.isArray(value.versions)
                ? Object.keys(value.versions as Record<string, unknown>)
                : [];
              resolve({ latestVersion: distTags.latest, distTags, versions });
            } catch (error) { reject(error); }
          });
        });
        request.setTimeout(15000, () => request.destroy(new Error("npm registry request timed out")));
        request.on("error", reject);
      });
      return result;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
