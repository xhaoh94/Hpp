import { create } from "zustand";

export type SidebarTab = "projects" | "files" | "settings";

export const DEFAULT_SIDEBAR_WIDTH = 250;
export const MIN_SIDEBAR_WIDTH = 180;

interface AppState {
  sidebarTab: SidebarTab;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  showAddProject: boolean;
  setSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  triggerAddProject: () => void;
  clearAddProject: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarTab: "projects",
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  showAddProject: false,
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)) }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  triggerAddProject: () => set({ sidebarTab: "projects", showAddProject: true }),
  clearAddProject: () => set({ showAddProject: false }),
}));
