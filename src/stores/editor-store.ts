import { create } from "zustand";

export interface EditorTab {
  /** Stable id — the absolute file path (paths are unique per tab). */
  key: string;
  /** Absolute file path on disk. */
  path: string;
  /** Display name (basename). */
  name: string;
  /** Pinned tabs survive "close others" / "close all" and sit at the front. */
  pinned: boolean;
  /** Unsaved changes (reported by the editor pane). */
  dirty: boolean;
}

interface EditorState {
  /** True when the VSCode-style editor layout is active. */
  mode: boolean;
  tabs: EditorTab[];
  activeKey: string | null;
  setMode: (mode: boolean) => void;
  toggleMode: () => void;
  /** Open a file in the editor — dedupe by path and activate it. */
  openFile: (path: string) => void;
  closeTab: (key: string) => void;
  /** Close every tab except `key` and pinned tabs. */
  closeOthers: (key: string) => void;
  /** Close every non-pinned tab. */
  closeAll: () => void;
  /** Close every non-pinned, non-dirty tab. */
  closeSaved: () => void;
  setActiveTab: (key: string) => void;
  togglePin: (key: string) => void;
  setDirty: (key: string, dirty: boolean) => void;
}

const getFileName = (path: string) => path.split(/[\\/]/).pop() || path;

function resolveNextActiveKey(
  allTabs: EditorTab[],
  closedIndex: number,
  previousActive: string | null,
): string | null {
  if (previousActive !== allTabs[closedIndex]?.key) return previousActive;
  if (allTabs.length <= 1) return null;
  const next = allTabs[closedIndex + 1] ?? allTabs[closedIndex - 1];
  return next.key;
}

export const useEditorStore = create<EditorState>((set) => ({
  mode: false,
  tabs: [],
  activeKey: null,

  setMode: (mode) => set({ mode }),

  toggleMode: () => set((state) => ({ mode: !state.mode })),

  openFile: (path) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.key === path);
      if (existing) return { activeKey: path };
      return {
        tabs: [...state.tabs, { key: path, path, name: getFileName(path), pinned: false, dirty: false }],
        activeKey: path,
      };
    }),

  closeTab: (key) =>
    set((state) => {
      const closedIndex = state.tabs.findIndex((tab) => tab.key === key);
      if (closedIndex < 0) return {};
      const tabs = state.tabs.filter((tab) => tab.key !== key);
      return {
        tabs,
        activeKey: resolveNextActiveKey(state.tabs, closedIndex, state.activeKey),
      };
    }),

  closeOthers: (key) =>
    set((state) => {
      const keepKey = state.tabs.some((tab) => tab.key === key) ? key : state.activeKey;
      const tabs = state.tabs.filter(
        (tab) => tab.key === keepKey || (tab.pinned && tab.key !== keepKey),
      );
      return {
        tabs,
        activeKey: tabs.some((tab) => tab.key === state.activeKey)
          ? state.activeKey
          : (tabs[0]?.key ?? null),
      };
    }),

  closeAll: () =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.pinned);
      return {
        tabs,
        activeKey: tabs.some((tab) => tab.key === state.activeKey)
          ? state.activeKey
          : (tabs[0]?.key ?? null),
      };
    }),

  closeSaved: () =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.pinned || tab.dirty);
      return {
        tabs,
        activeKey: tabs.some((tab) => tab.key === state.activeKey)
          ? state.activeKey
          : (tabs[0]?.key ?? null),
      };
    }),

  setActiveTab: (key) =>
    set((state) => {
      if (!state.tabs.some((tab) => tab.key === key)) return {};
      return { activeKey: key };
    }),

  togglePin: (key) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === key ? { ...tab, pinned: !tab.pinned } : tab,
      ),
    })),

  setDirty: (key, dirty) =>
    set((state) => {
      const target = state.tabs.find((tab) => tab.key === key);
      if (!target || target.dirty === dirty) return {};
      return {
        tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, dirty } : tab)),
      };
    }),
}));
