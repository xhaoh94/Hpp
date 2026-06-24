import { create } from "zustand";

export type SidebarTab = "projects" | "files" | "settings";

interface AppState {
  sidebarTab: SidebarTab;
  sidebarCollapsed: boolean;
  showAddProject: boolean;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleSidebar: () => void;
  triggerAddProject: () => void;
  clearAddProject: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarTab: "projects",
  sidebarCollapsed: false,
  showAddProject: false,
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  triggerAddProject: () => set({ sidebarTab: "projects", showAddProject: true }),
  clearAddProject: () => set({ showAddProject: false }),
}));
