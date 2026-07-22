import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_FILTERS,
  getFileFilterKey,
  isFileEntryExcluded,
  normalizeFileFilters,
} from "./file-filters";

describe("file filters", () => {
  it("uses defaults for missing settings but preserves explicit empty lists", () => {
    expect(normalizeFileFilters(undefined)).toEqual(DEFAULT_FILE_FILTERS);
    expect(normalizeFileFilters({
      excludeFolders: [],
      excludeExtensions: [],
      excludeFiles: [],
    })).toEqual({
      excludeFolders: [],
      excludeExtensions: [],
      excludeFiles: [],
    });
  });

  it("trims, normalizes, and de-duplicates rules", () => {
    expect(normalizeFileFilters({
      excludeFolders: [" build ", "BUILD", 42],
      excludeExtensions: ["log", " .D.TS ", ".LOG"],
      excludeFiles: [" secrets.json ", "SECRETS.JSON"],
    })).toEqual({
      excludeFolders: ["build"],
      excludeExtensions: [".log", ".D.TS"],
      excludeFiles: ["secrets.json"],
    });
  });

  it("matches directory names, file names, and multi-part suffixes case-insensitively", () => {
    const filters = normalizeFileFilters({
      excludeFolders: ["generated"],
      excludeExtensions: [".d.ts"],
      excludeFiles: ["local.env"],
    });

    expect(isFileEntryExcluded({ name: "Generated", type: "folder" }, filters)).toBe(true);
    expect(isFileEntryExcluded({ name: "index.D.TS", type: "file" }, filters)).toBe(true);
    expect(isFileEntryExcluded({ name: "LOCAL.ENV", type: "file" }, filters)).toBe(true);
    expect(isFileEntryExcluded({ name: "generated", type: "file" }, filters)).toBe(false);
    expect(isFileEntryExcluded({ name: "local.env", type: "folder" }, filters)).toBe(false);
  });

  it("builds a stable key across casing and ordering changes", () => {
    const first = normalizeFileFilters({
      excludeFolders: ["Build", "coverage"],
      excludeExtensions: [".LOG", ".map"],
      excludeFiles: ["LOCAL.env", "secret.txt"],
    });
    const second = normalizeFileFilters({
      excludeFolders: ["COVERAGE", "build"],
      excludeExtensions: [".MAP", ".log"],
      excludeFiles: ["SECRET.TXT", "local.ENV"],
    });
    expect(getFileFilterKey(first)).toBe(getFileFilterKey(second));
  });
});
