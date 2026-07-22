import { describe, expect, it } from "vitest";
import {
  getFileSearchMatch,
  rankFileSearchItems,
  rankFileSearchItemsAsync,
} from "./file-search-ranking";

const item = (name: string, isDirectory = false) => ({
  name,
  path: `/project/${name}`,
  isDirectory,
});

describe("file search ranking", () => {
  it("orders exact, contiguous, and fuzzy matches in separate relevance tiers", () => {
    const ranked = rankFileSearchItems([
      item("FileChange.ts"),
      item("xxxchat.ts"),
      item("chat", true),
      item("chaxxxt.ts"),
      item("ChatPanel.css"),
      item("unrelated.ts"),
      item("chat-store.ts"),
    ], "chat");

    expect(ranked[0].name).toBe("chat");
    expect(ranked.slice(1, 4).map((entry) => getFileSearchMatch(entry.name, "chat")?.kind))
      .toEqual(["substring", "substring", "substring"]);
    expect(ranked.slice(4).map((entry) => getFileSearchMatch(entry.name, "chat")?.kind))
      .toEqual(["fuzzy", "fuzzy"]);
    expect(ranked.map((entry) => entry.name)).not.toContain("unrelated.ts");
  });

  it("prefers a contiguous prefix over a later contiguous occurrence", () => {
    const ranked = rankFileSearchItems([
      item("xxxchat"),
      item("chatxxx"),
    ], "chat");

    expect(ranked.map((entry) => entry.name)).toEqual(["chatxxx", "xxxchat"]);
  });

  it("does not let directory priority outrank match quality", () => {
    const ranked = rankFileSearchItems([
      item("chaxxxt", true),
      item("ChatPanel.tsx"),
      item("chat"),
    ], "CHAT");

    expect(ranked.map((entry) => entry.name)).toEqual(["chat", "ChatPanel.tsx", "chaxxxt"]);
  });

  it("prefers compact fuzzy matches with fewer gaps", () => {
    const ranked = rankFileSearchItems([
      item("FileChange.ts"),
      item("chaxxxt"),
    ], "chat");

    expect(ranked.map((entry) => entry.name)).toEqual(["chaxxxt", "FileChange.ts"]);
  });

  it("uses the tightest fuzzy window when the first query character repeats", () => {
    const match = getFileSearchMatch("a---a-b-c", "abc");
    expect(match).toMatchObject({
      kind: "fuzzy",
      start: 4,
      span: 5,
      indices: [4, 6, 8],
    });

    const ranked = rankFileSearchItems([
      item("a---b---c"),
      item("a---a-b-c"),
    ], "abc");
    expect(ranked.map((entry) => entry.name)).toEqual(["a---a-b-c", "a---b---c"]);
  });

  it("returns match indices for the same highlighting used by ranking", () => {
    expect(getFileSearchMatch("ChatPanel.tsx", "chat")).toMatchObject({
      kind: "substring",
      indices: [0, 1, 2, 3],
    });
    expect(getFileSearchMatch("chaxxxt", "chat")).toMatchObject({
      kind: "fuzzy",
      indices: [0, 1, 2, 6],
      gapCount: 3,
    });
  });

  it("returns the same leading results when ranking is bounded", () => {
    const items = Array.from({ length: 2_000 }, (_, index) => item(
      index % 3 === 0 ? `chat-${index}.ts` : `component-${index}.ts`,
      index % 11 === 0,
    ));

    const fullyRanked = rankFileSearchItems(items, "chat");
    const topResults = rankFileSearchItems(items, "chat", 25);

    expect(topResults).toEqual(fullyRanked.slice(0, 25));
  });

  it("keeps bounded ranking equivalent across match tiers and tie breakers", () => {
    const items = [
      { ...item("chat"), path: "/z/chat" },
      { ...item("chat"), path: "/a/chat" },
      item("chat-panel.ts"),
      item("my-chat.ts"),
      item("chaxxxt.ts"),
      item("FileChange.ts"),
      item("unrelated.ts"),
      item("chat", true),
    ].reverse();
    const fullyRanked = rankFileSearchItems(items, "chat");

    for (const limit of [1, 2, 3, 5, 20]) {
      expect(rankFileSearchItems(items, "chat", limit)).toEqual(fullyRanked.slice(0, limit));
    }
  });

  it("prefers the shallower path for duplicate names", () => {
    const ranked = rankFileSearchItems([
      { ...item("ChatPanel.tsx"), path: "C:\\repo\\.tmp\\generated\\src\\ChatPanel.tsx" },
      { ...item("ChatPanel.tsx"), path: "C:\\repo\\src\\ChatPanel.tsx" },
    ], "chat");

    expect(ranked.map((entry) => entry.path)).toEqual([
      "C:\\repo\\src\\ChatPanel.tsx",
      "C:\\repo\\.tmp\\generated\\src\\ChatPanel.tsx",
    ]);
  });

  it("yields and honors cancellation while ranking large indexes", async () => {
    const items = Array.from({ length: 2_000 }, (_, index) => item(`chat-${index}.ts`));
    const controller = new AbortController();
    const pending = rankFileSearchItemsAsync(items, "chat", 25, {
      signal: controller.signal,
      yieldEvery: 25,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(pending).resolves.toEqual([]);
  });

  it("keeps async chunked ranking equivalent to synchronous ranking", async () => {
    const items = Array.from({ length: 500 }, (_, index) => item(
      index % 4 === 0 ? `chat-${index}` : index % 4 === 1 ? `xchat-${index}` : `ch-x-a-t-${index}`,
      index % 9 === 0,
    ));

    await expect(rankFileSearchItemsAsync(items, "chat", 30, { yieldEvery: 37 }))
      .resolves.toEqual(rankFileSearchItems(items, "chat", 30));
  });
});
