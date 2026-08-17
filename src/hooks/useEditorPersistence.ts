import { useEffect, useRef } from "react";
import { useEditorStore, type EditorTab } from "@/stores/editor-store";

const STORAGE_KEY = "editor";

export interface PersistedEditorState {
  mode: boolean;
  tabs: Array<Pick<EditorTab, "key" | "path" | "name" | "pinned">>;
  activeKey: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const isPersistedEditorState = (value: unknown): value is PersistedEditorState => {
  if (!isRecord(value)) return false;
  if (typeof value.mode !== "boolean") return false;
  if (!Array.isArray(value.tabs)) return false;
  if (value.activeKey !== null && typeof value.activeKey !== "string") return false;
  for (const tab of value.tabs) {
    if (!isRecord(tab)) return false;
    if (typeof tab.key !== "string" || !tab.key) return false;
    if (typeof tab.path !== "string" || !tab.path) return false;
    if (typeof tab.name !== "string") return false;
    if (typeof tab.pinned !== "boolean") return false;
  }
  return true;
};

export function serializeEditorState(state: Pick<ReturnType<typeof useEditorStore.getState>, "mode" | "tabs" | "activeKey">): PersistedEditorState {
  return {
    mode: state.mode,
    tabs: state.tabs.map(({ key, path, name, pinned }) => ({ key, path, name, pinned })),
    activeKey: state.activeKey,
  };
}

function editorStateSignature(state: PersistedEditorState): string {
  return JSON.stringify(state);
}

export function useEditorPersistence(): void {
  const restoredRef = useRef(false);
  const lastSavedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void window.electronAPI.loadData(STORAGE_KEY)
      .catch(() => null)
      .then((raw) => {
        if (cancelled) return;

        const currentState = useEditorStore.getState();
        const hasLocalChanges = currentState.mode || currentState.tabs.length > 0 || currentState.activeKey !== null;

        // 如果用户在恢复请求完成前已经操作过编辑器，不要用旧磁盘快照覆盖本地操作。
        if (isPersistedEditorState(raw) && !hasLocalChanges) {
          const restoredTabs: EditorTab[] = raw.tabs.map((tab) => ({
            key: tab.key,
            path: tab.path,
            name: tab.name || tab.path.split(/[\\/]/).pop() || tab.path,
            pinned: tab.pinned,
            dirty: false,
          }));
          const validPaths = new Set(restoredTabs.map((tab) => tab.key));
          const activeKey = validPaths.has(raw.activeKey ?? "")
            ? raw.activeKey
            : (restoredTabs[0]?.key ?? null);

          useEditorStore.setState({
            mode: raw.mode,
            tabs: restoredTabs,
            activeKey,
          });
        }

        restoredRef.current = true;

        // 首次启动没有旧文件，或恢复期间发生了本地操作时，立即建立最新快照。
        const currentSnapshot = serializeEditorState(useEditorStore.getState());
        lastSavedSignatureRef.current = editorStateSignature(currentSnapshot);
        void window.electronAPI.saveData(STORAGE_KEY, currentSnapshot).then((result) => {
          if (!result.success) {
            console.error("[editor-persistence] initial save failed:", result.error);
          }
        }).catch((error) => {
          console.error("[editor-persistence] initial save failed:", error);
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state) => {
      if (!restoredRef.current) return;

      const snapshot = serializeEditorState(state);
      const signature = editorStateSignature(snapshot);
      if (signature === lastSavedSignatureRef.current) return;
      lastSavedSignatureRef.current = signature;

      // 编辑器状态很小，直接保存可以避免关闭窗口时丢失最后 300ms 的操作。
      void window.electronAPI.saveData(STORAGE_KEY, snapshot).then((result) => {
        if (!result.success) {
          console.error("[editor-persistence] save failed:", result.error);
        }
      }).catch((error) => {
        console.error("[editor-persistence] save failed:", error);
      });
    });

    return unsubscribe;
  }, []);
}
