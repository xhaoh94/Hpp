import { lazy, Suspense } from "react";
import { useAppStore } from "@/stores/app-store";
import { useShallow } from "zustand/react/shallow";
import { ProjectView } from "@/components/sidebar/ProjectView";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
import "./Layout.css";

// 设置页只在切到 settings 标签时渲染，没必要进首屏 bundle。
const SettingsView = lazy(() => import("@/components/sidebar/SettingsView").then((module) => ({ default: module.SettingsView })));

export function ContentArea() {
  const { sidebarTab, sidebarCollapsed } = useAppStore(useShallow((state) => ({
    sidebarTab: state.sidebarTab,
    sidebarCollapsed: state.sidebarCollapsed,
  })));

  return (
    <aside className={`sidebar-panel ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="sidebar-tab-view" hidden={sidebarTab !== "projects"}>
        <ProjectView />
      </div>
      <div className="sidebar-tab-view" hidden={sidebarTab !== "files"}>
        <FileExplorer />
      </div>
      {sidebarTab === "settings" && (
        <Suspense fallback={null}>
          <SettingsView />
        </Suspense>
      )}
    </aside>
  );
}
