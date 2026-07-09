import { describe, expect, it } from "vitest";
// @ts-expect-error Vitest can import the worker's ESM helper directly.
import {
  getCodexTurnId,
  getRollbackTurnCountForIndex,
  getRollbackTurnCountForTarget,
  normalizeCodexTurns,
} from "./codex-fork-utils.mjs";

describe("codex fork utils", () => {
  it("normalizes turns from known app-server result shapes", () => {
    expect(normalizeCodexTurns({ thread: { turns: [{ id: "a" }, { turnId: "b" }] } }).map(getCodexTurnId))
      .toEqual(["a", "b"]);
    expect(normalizeCodexTurns({ data: [{ id: "c" }, { id: "" }, null] }).map(getCodexTurnId))
      .toEqual(["c"]);
  });

  it("calculates rollback count from the native target turn", () => {
    const turns = [{ id: "turn-1" }, { turnId: "turn-2" }, { id: "turn-3" }, { id: "turn-4" }];

    expect(getRollbackTurnCountForTarget(turns, "turn-2")).toBe(2);
    expect(getRollbackTurnCountForTarget(turns, "turn-4")).toBe(0);
    expect(getRollbackTurnCountForTarget(turns, "missing")).toBeNull();
  });

  it("calculates rollback count from a native turn index fallback", () => {
    const turns = [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }, { id: "turn-4" }];

    expect(getRollbackTurnCountForIndex(turns, 1)).toBe(2);
    expect(getRollbackTurnCountForIndex(turns, 3)).toBe(0);
    expect(getRollbackTurnCountForIndex(turns, -1)).toBeNull();
    expect(getRollbackTurnCountForIndex(turns, 4)).toBeNull();
  });
});
