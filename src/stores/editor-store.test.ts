import { describe, expect, it, beforeEach } from "vitest";
import { useEditorStore } from "./editor-store";

beforeEach(() => {
  useEditorStore.setState({
    mode: false,
    tabs: [],
    activeKey: null,
  });
});

describe("editor store — mode", () => {
  it("toggles the editor mode", () => {
    useEditorStore.getState().toggleMode();
    expect(useEditorStore.getState().mode).toBe(true);
    useEditorStore.getState().toggleMode();
    expect(useEditorStore.getState().mode).toBe(false);
  });

  it("sets the mode explicitly", () => {
    useEditorStore.getState().setMode(true);
    expect(useEditorStore.getState().mode).toBe(true);
  });
});

describe("editor store — openFile", () => {
  it("opens a file and activates it with a basename", () => {
    useEditorStore.getState().openFile("C:\\proj\\src\\App.tsx");
    const { tabs, activeKey } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe("App.tsx");
    expect(tabs[0].pinned).toBe(false);
    expect(tabs[0].dirty).toBe(false);
    expect(activeKey).toBe("C:\\proj\\src\\App.tsx");
  });

  it("dedupes by path and just activates the existing tab", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().openFile("/a/two.ts");
    useEditorStore.getState().openFile("/a/one.ts");
    const state = useEditorStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBe("/a/one.ts");
  });
});

describe("editor store — closeTab", () => {
  it("closes a tab and activates its right neighbour", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().openFile("/a/two.ts");
    useEditorStore.getState().openFile("/a/three.ts");
    useEditorStore.getState().setActiveTab("/a/two.ts");
    useEditorStore.getState().closeTab("/a/two.ts");
    const state = useEditorStore.getState();
    expect(state.tabs.map((t) => t.name)).toEqual(["one.ts", "three.ts"]);
    expect(state.activeKey).toBe("/a/three.ts");
  });

  it("activates the left neighbour when closing the last tab", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().openFile("/a/two.ts");
    useEditorStore.getState().setActiveTab("/a/two.ts");
    useEditorStore.getState().closeTab("/a/two.ts");
    expect(useEditorStore.getState().activeKey).toBe("/a/one.ts");
  });

  it("clears activeKey when the last tab closes", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().closeTab("/a/one.ts");
    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().activeKey).toBeNull();
  });

  it("keeps the active tab when closing an inactive one", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().openFile("/a/two.ts");
    useEditorStore.getState().closeTab("/a/two.ts");
    expect(useEditorStore.getState().activeKey).toBe("/a/one.ts");
  });
});

describe("editor store — pinned tabs", () => {
  it("toggles pin state", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().togglePin("/a/one.ts");
    expect(useEditorStore.getState().tabs[0].pinned).toBe(true);
    useEditorStore.getState().togglePin("/a/one.ts");
    expect(useEditorStore.getState().tabs[0].pinned).toBe(false);
  });

  it("closeOthers keeps pinned tabs and the target tab", () => {
    useEditorStore.getState().openFile("/a/pinned.ts");
    useEditorStore.getState().togglePin("/a/pinned.ts");
    useEditorStore.getState().openFile("/a/other.ts");
    useEditorStore.getState().openFile("/a/target.ts");
    useEditorStore.getState().closeOthers("/a/target.ts");
    const state = useEditorStore.getState();
    expect(state.tabs.map((t) => t.name).sort()).toEqual(["pinned.ts", "target.ts"]);
    expect(state.activeKey).toBe("/a/target.ts");
  });

  it("closeAll keeps only pinned tabs", () => {
    useEditorStore.getState().openFile("/a/pinned.ts");
    useEditorStore.getState().togglePin("/a/pinned.ts");
    useEditorStore.getState().openFile("/a/other.ts");
    useEditorStore.getState().closeAll();
    const state = useEditorStore.getState();
    expect(state.tabs.map((t) => t.name)).toEqual(["pinned.ts"]);
    expect(state.activeKey).toBe("/a/pinned.ts");
  });

  it("closeSaved keeps pinned and dirty tabs", () => {
    useEditorStore.getState().openFile("/a/pinned.ts");
    useEditorStore.getState().togglePin("/a/pinned.ts");
    useEditorStore.getState().openFile("/a/dirty.ts");
    useEditorStore.getState().setDirty("/a/dirty.ts", true);
    useEditorStore.getState().openFile("/a/clean.ts");
    useEditorStore.getState().closeSaved();
    const state = useEditorStore.getState();
    expect(state.tabs.map((t) => t.name).sort()).toEqual(["dirty.ts", "pinned.ts"]);
  });
});

describe("editor store — setDirty", () => {
  it("updates the dirty flag", () => {
    useEditorStore.getState().openFile("/a/one.ts");
    useEditorStore.getState().setDirty("/a/one.ts", true);
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true);
    useEditorStore.getState().setDirty("/a/one.ts", false);
    expect(useEditorStore.getState().tabs[0].dirty).toBe(false);
  });

  it("ignores unknown tabs", () => {
    expect(() => useEditorStore.getState().setDirty("/missing.ts", true)).not.toThrow();
  });
});
