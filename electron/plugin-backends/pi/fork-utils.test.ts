import { describe, expect, it } from "vitest";
// @ts-expect-error JavaScript worker helper intentionally has no declaration file.
import { resolvePiForkEntryId } from "./pi-fork-utils.mjs";

const message = (id: string, parentId: string | null, role: string, text: string) => ({
  type: "message",
  id,
  parentId,
  message: { role, content: [{ type: "text", text }] },
});

describe("Pi native fork mapping", () => {
  const entries = [
    message("user-1", null, "user", "question one"),
    message("assistant-1", "user-1", "assistant", "answer one"),
    message("user-2", "assistant-1", "user", "question two"),
    message("assistant-2", "user-2", "assistant", "answer two"),
  ];

  it("uses native turn metadata when available", () => {
    expect(resolvePiForkEntryId(entries, {
      targetTurnId: "assistant-1",
      sourceUserMessageIndex: 0,
    })).toBe("assistant-1");
  });

  it("maps the first user message to its completed assistant turn", () => {
    expect(resolvePiForkEntryId(entries, {
      sourceUserMessageIndex: 0,
      sourceMessageContent: "question one",
    })).toBe("assistant-1");
  });

  it("maps an assistant message to the exact Pi entry", () => {
    expect(resolvePiForkEntryId(entries, {
      sourceUserMessageIndex: 1,
      sourceMessageContent: "answer two",
    })).toBe("assistant-2");
  });

  it("refuses to fork an unfinished user turn", () => {
    expect(resolvePiForkEntryId([message("user-1", null, "user", "question")], {
      sourceUserMessageIndex: 0,
      sourceMessageContent: "question",
    })).toBeUndefined();
  });
});
