import { describe, expect, it } from "vitest";
import { buildGitPatchForHunks, parseGitPatch } from "./git-hunks";

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-old
+new
 same
@@ -10,2 +10,2 @@
-old2
+new2
 same2
`;

describe("git hunks", () => {
  it("parses file headers and hunks", () => {
    const parsed = parseGitPatch(patch);
    expect(parsed.header).toHaveLength(3);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].header).toContain("@@ -1");
    expect(parsed.hunks[1].lines).toContain("+new2");
  });

  it("builds a patch containing only selected hunks", () => {
    const parsed = parseGitPatch(patch);
    const selected = buildGitPatchForHunks(parsed, [1]);
    expect(selected).toContain("@@ -10");
    expect(selected).not.toContain("@@ -1,");
    expect(selected).toContain("+new2");
    expect(selected).not.toContain("+new\n");
  });

  it("rejects unknown hunk indexes", () => {
    expect(buildGitPatchForHunks(parseGitPatch(patch), [9])).toBeNull();
  });
});
