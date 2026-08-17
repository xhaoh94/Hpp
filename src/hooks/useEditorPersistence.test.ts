import { describe, expect, it } from "vitest";
import { isPersistedEditorState, serializeEditorState } from "./useEditorPersistence";

const tab = {
  key: "C:\\project\\src\\App.tsx",
  path: "C:\\project\\src\\App.tsx",
  name: "App.tsx",
  pinned: true,
  dirty: true,
};

describe("editor persistence", () => {
  it("validates persisted layout metadata without requiring editor text", () => {
    expect(isPersistedEditorState({
      mode: true,
      tabs: [{ key: tab.key, path: tab.path, name: tab.name, pinned: tab.pinned }],
      activeKey: tab.key,
    })).toBe(true);
    expect(isPersistedEditorState({
      mode: true,
      tabs: [{ key: tab.key, path: tab.path, name: tab.name }],
      activeKey: tab.key,
    })).toBe(false);
  });

  it("serializes mode, tabs and active tab while dropping dirty runtime state", () => {
    expect(serializeEditorState({
      mode: true,
      tabs: [tab],
      activeKey: tab.key,
    })).toEqual({
      mode: true,
      tabs: [{ key: tab.key, path: tab.path, name: tab.name, pinned: true }],
      activeKey: tab.key,
    });
  });
});
