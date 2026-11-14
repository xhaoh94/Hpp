import { describe, expect, it } from "vitest";

import { toRepoRelative } from "./GitFileTree";

describe("toRepoRelative", () => {
  it("strips the repo root and normalises separators", () => {
    expect(toRepoRelative("C:\\Project\\Hpp", "C:\\Project\\Hpp\\src\\a.ts")).toBe("src/a.ts");
    expect(toRepoRelative("C:/Project/Hpp", "C:/Project/Hpp/src/a.ts")).toBe("src/a.ts");
    expect(toRepoRelative("C:\\Project\\Hpp\\", "C:\\Project\\Hpp\\a.ts")).toBe("a.ts");
  });

  it("matches the root case-insensitively (Windows drives are case-insensitive)", () => {
    expect(toRepoRelative("C:\\Project\\Hpp", "c:\\project\\hpp\\src\\a.ts")).toBe("src/a.ts");
  });

  it("leaves paths outside the repo untouched", () => {
    expect(toRepoRelative("C:\\Project\\Hpp", "C:\\Other\\a.ts")).toBe("C:/Other/a.ts");
    // 同前缀但不同目录，不能误判成仓库内
    expect(toRepoRelative("C:\\Project\\Hpp", "C:\\Project\\Hpp2\\a.ts")).toBe("C:/Project/Hpp2/a.ts");
  });
});
