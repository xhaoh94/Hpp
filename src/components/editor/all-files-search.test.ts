import { describe, expect, it } from "vitest";
import {
  replaceAllFilesSearchResults,
  searchAllFilesContent,
  type AllFilesSearchFile,
  type AllFilesSearchResult,
} from "./all-files-search";

const file: AllFilesSearchFile = {
  path: "C:\\project\\src\\sample.ts",
  name: "sample.ts",
  relPath: "src\\sample.ts",
  dirPath: "src",
};

function result(path: string, lineNumber: number, matchStart = 0): AllFilesSearchResult {
  return {
    path,
    name: path.split("\\").pop() ?? path,
    relPath: path,
    dirPath: "",
    lineNumber,
    preview: "match",
    matchStart,
    matchEnd: matchStart + 5,
  };
}

describe("all-files search synchronization", () => {
  it("recalculates the edited file and removes matches that no longer exist", () => {
    const next = searchAllFilesContent(file, "first\nchanged\nlast", "match", {});
    const results = [
      result(file.path, 1),
      result(file.path, 2),
      result("C:\\project\\other.ts", 4),
    ];

    expect(replaceAllFilesSearchResults(results, file.path, next)).toEqual([
      result("C:\\project\\other.ts", 4),
    ]);
  });

  it("keeps the edited file's position while updating line numbers and columns", () => {
    const next = searchAllFilesContent(file, "skip\n  match here\nmatch", "match", {});
    const results = [
      result("C:\\project\\before.ts", 1),
      result(file.path, 1),
      result("C:\\project\\after.ts", 2),
    ];

    expect(replaceAllFilesSearchResults(results, file.path, next)).toMatchObject([
      result("C:\\project\\before.ts", 1),
      { path: file.path, lineNumber: 2, matchStart: 2, matchEnd: 7 },
      { path: file.path, lineNumber: 3, matchStart: 0, matchEnd: 5 },
      result("C:\\project\\after.ts", 2),
    ]);
  });

  it("does not move the result list's other files when the edited file gains matches", () => {
    const next = searchAllFilesContent(file, "match\nmatch", "match", {});
    const results = [result("C:\\project\\before.ts", 1), result("C:\\project\\after.ts", 2)];

    expect(replaceAllFilesSearchResults(results, file.path, next).map((item) => item.path)).toEqual([
      "C:\\project\\before.ts",
      "C:\\project\\after.ts",
      file.path,
      file.path,
    ]);
  });
});
