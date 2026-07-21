import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHostSessionDrafts, clearSessionDraft, loadSessionDraft, pruneSessionDrafts, sanitizePairedHosts, sanitizeSessionDraft, saveSessionDraft, withPairedHostMetadata } from "./storage";

describe("paired host metadata", () => {
  it("keeps a local alias and note without requiring them for older saved hosts", () => {
    const base = {
      id: "saved-1",
      hostId: "host-1",
      hostName: "DESKTOP-123",
      baseUrl: "http://192.168.1.2:47831",
      deviceId: "device-1",
      token: "token-1",
    };
    expect(sanitizePairedHosts([base, { ...base, id: "saved-2", alias: " Work PC ", note: " Office " }]))
      .toEqual([
        base,
        { ...base, id: "saved-2", alias: "Work PC", note: "Office" },
      ]);
  });

  it("keeps unique candidate addresses while loading new saved hosts", () => {
    const host = {
      id: "saved-1",
      hostId: "host-1",
      hostName: "DESKTOP-123",
      baseUrl: "http://192.168.1.2:47831",
      baseUrls: [" http://192.168.1.2:47831 ", "http://100.64.0.2:47831", "http://100.64.0.2:47831"],
      deviceId: "device-1",
      token: "token-1",
    };
    expect(sanitizePairedHosts([host])[0].baseUrls).toEqual([
      "http://192.168.1.2:47831",
      "http://100.64.0.2:47831",
    ]);
  });

  it("updates and clears a saved desktop alias and note without changing credentials", () => {
    const host = {
      id: "saved-1",
      hostId: "host-1",
      hostName: "DESKTOP-123",
      alias: "Old name",
      note: "Old note",
      baseUrl: "http://192.168.1.2:47831",
      deviceId: "device-1",
      token: "token-1",
    };
    expect(withPairedHostMetadata(host, " Work PC ", " Office ")).toEqual({
      ...host,
      alias: "Work PC",
      note: "Office",
    });
    expect(withPairedHostMetadata(host, " ", " ")).toEqual({
      id: host.id,
      hostId: host.hostId,
      hostName: host.hostName,
      baseUrl: host.baseUrl,
      deviceId: host.deviceId,
      token: host.token,
    });
  });
});

describe("mobile session drafts", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps text and unique reference session ids", () => {
    expect(sanitizeSessionDraft({
      text: "unfinished prompt",
      referenceSessionIds: ["session-2", "session-2", "session-3"],
      updatedAt: 123,
    })).toEqual({
      text: "unfinished prompt",
      referenceSessionIds: ["session-2", "session-3"],
      updatedAt: 123,
    });
  });

  it("keeps a valid selected action and ignores malformed legacy values", () => {
    expect(sanitizeSessionDraft({
      text: "",
      referenceSessionIds: [],
      action: { kind: "skill", name: " review " },
      updatedAt: 123,
    })).toMatchObject({ action: { kind: "skill", name: "review" } });
    expect(sanitizeSessionDraft({
      text: "legacy",
      referenceSessionIds: [],
      action: { kind: "tool", name: "review" },
      updatedAt: 123,
    })).not.toHaveProperty("action");
  });

  it("rejects malformed or oversized draft text", () => {
    expect(sanitizeSessionDraft(null)).toBeNull();
    expect(sanitizeSessionDraft({ text: 1 })).toBeNull();
    expect(sanitizeSessionDraft({ text: "x".repeat(200_001) })).toBeNull();
  });

  it("stores, loads, and clears a Web session draft", async () => {
    await saveSessionDraft("host-1", "session-1", {
      text: "continue here",
      referenceSessionIds: ["session-2"],
      action: { kind: "skill", name: "review" },
    });
    await expect(loadSessionDraft("host-1", "session-1")).resolves.toMatchObject({
      text: "continue here",
      referenceSessionIds: ["session-2"],
      action: { kind: "skill", name: "review" },
    });

    await clearSessionDraft("host-1", "session-1");
    await expect(loadSessionDraft("host-1", "session-1")).resolves.toBeNull();
  });

  it("prunes drafts for removed sessions and removed desktops", async () => {
    await saveSessionDraft("host-1", "kept", { text: "keep", referenceSessionIds: [] });
    await saveSessionDraft("host-1", "removed", { text: "remove", referenceSessionIds: [] });
    await saveSessionDraft("host-2", "other", { text: "other", referenceSessionIds: [] });

    await pruneSessionDrafts("host-1", ["kept"]);
    await expect(loadSessionDraft("host-1", "kept")).resolves.toMatchObject({ text: "keep" });
    await expect(loadSessionDraft("host-1", "removed")).resolves.toBeNull();
    await expect(loadSessionDraft("host-2", "other")).resolves.toMatchObject({ text: "other" });

    await clearHostSessionDrafts("host-2");
    await expect(loadSessionDraft("host-2", "other")).resolves.toBeNull();
  });
});
