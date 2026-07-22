export interface FileFilterConfig {
  excludeFolders: string[];
  excludeExtensions: string[];
  excludeFiles: string[];
}

export type FilterableFileEntry = {
  name: string;
  type: "file" | "folder";
};

export const DEFAULT_FILE_FILTERS: FileFilterConfig = {
  excludeFolders: ["node_modules", ".git", "dist"],
  excludeExtensions: [".pyc", ".class"],
  excludeFiles: [".env"],
};

export const FILE_FILTERS_UPDATED_EVENT = "file-filters-updated";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeRuleList(
  value: unknown,
  fallback: string[],
  normalizeRule: (rule: string) => string = (rule) => rule,
): string[] {
  if (!Array.isArray(value)) return [...fallback];

  const seen = new Set<string>();
  const rules: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const rule = normalizeRule(item.trim());
    if (!rule) continue;
    const key = rule.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }
  return rules;
}

export function normalizeFileFilters(value: unknown): FileFilterConfig {
  const filters = asRecord(value);
  return {
    excludeFolders: normalizeRuleList(filters.excludeFolders, DEFAULT_FILE_FILTERS.excludeFolders),
    excludeExtensions: normalizeRuleList(
      filters.excludeExtensions,
      DEFAULT_FILE_FILTERS.excludeExtensions,
      (rule) => rule.startsWith(".") ? rule : `.${rule}`,
    ),
    excludeFiles: normalizeRuleList(filters.excludeFiles, DEFAULT_FILE_FILTERS.excludeFiles),
  };
}

export function isFileEntryExcluded(entry: FilterableFileEntry, filters: FileFilterConfig): boolean {
  const name = entry.name.toLowerCase();
  if (entry.type === "folder") {
    return filters.excludeFolders.some((rule) => rule.toLowerCase() === name);
  }

  if (filters.excludeFiles.some((rule) => rule.toLowerCase() === name)) return true;
  return filters.excludeExtensions.some((rule) => name.endsWith(rule.toLowerCase()));
}

export function getFileFilterKey(filters: FileFilterConfig): string {
  const normalizeKeyRules = (rules: string[]) => rules
    .map((rule) => rule.toLowerCase())
    .sort();
  return JSON.stringify([
    normalizeKeyRules(filters.excludeFolders),
    normalizeKeyRules(filters.excludeExtensions),
    normalizeKeyRules(filters.excludeFiles),
  ]);
}
