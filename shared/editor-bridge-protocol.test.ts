import { describe, expect, it } from "vitest";

import {
  EDITOR_BRIDGE_MAX_TEXT_BYTES,
  EDITOR_BRIDGE_PROTOCOL_VERSION,
  editorBridgeSendSchema,
} from "./editor-bridge-protocol";

const base = { version: EDITOR_BRIDGE_PROTOCOL_VERSION, client: "vscode", path: "/repo/src/a.ts" } as const;

describe("editor bridge protocol", () => {
  it("accepts a selection request with a line range", () => {
    const parsed = editorBridgeSendSchema.parse({ ...base, kind: "selection", startLine: 12, endLine: 20 });
    expect(parsed.startLine).toBe(12);
    expect(parsed.endLine).toBe(20);
  });

  it("accepts a whole-file request without line numbers", () => {
    const parsed = editorBridgeSendSchema.parse({ ...base, kind: "file" });
    expect(parsed.startLine).toBeUndefined();
  });

  it("accepts a folder reference", () => {
    const parsed = editorBridgeSendSchema.parse({ ...base, kind: "folder", path: "/repo/src/lib" });
    expect(parsed).toMatchObject({ kind: "folder", path: "/repo/src/lib" });
  });

  it("rejects a selection missing its line range", () => {
    const result = editorBridgeSendSchema.safeParse({ ...base, kind: "selection", startLine: 3 });
    expect(result.success).toBe(false);
  });

  it("rejects an inverted line range", () => {
    const result = editorBridgeSendSchema.safeParse({ ...base, kind: "selection", startLine: 9, endLine: 4 });
    expect(result.success).toBe(false);
  });

  it("caps the literal text so a huge selection cannot be pushed through", () => {
    const result = editorBridgeSendSchema.safeParse({
      ...base,
      kind: "selection",
      startLine: 1,
      endLine: 2,
      text: "x".repeat(EDITOR_BRIDGE_MAX_TEXT_BYTES + 1),
    });
    expect(result.success).toBe(false);
  });

  it("keeps the optional dirty-buffer text", () => {
    const parsed = editorBridgeSendSchema.parse({
      ...base,
      kind: "selection",
      startLine: 1,
      endLine: 1,
      text: "const a = 1;",
    });
    expect(parsed.text).toBe("const a = 1;");
  });
});
