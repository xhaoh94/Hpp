interface ParsedVersion {
  core: number[];
  prerelease: Array<number | string> | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;

  const core = match[1].split(".").map((part) => Number.parseInt(part, 10));
  const prerelease = match[2]
    ? match[2].split(".").map((part) => /^\d+$/.test(part) ? Number.parseInt(part, 10) : part)
    : null;
  return { core, prerelease };
}

export function isValidVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

export function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left) throw new Error(`无效版本号：${leftVersion}`);
  if (!right) throw new Error(`无效版本号：${rightVersion}`);

  const coreLength = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const difference = (left.core[index] || 0) - (right.core[index] || 0);
    if (difference !== 0) return difference;
  }

  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function meetsMinimumVersion(currentVersion: string, minimumVersion: string): boolean {
  return compareVersions(currentVersion, minimumVersion) >= 0;
}
