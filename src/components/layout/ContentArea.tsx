import { useAppStore } from "@/stores/app-store";
import { ProjectView } from "@/components/sidebar/ProjectView";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
import { SettingsView } from "@/components/sidebar/SettingsView";
import "./Layout.css";

export function ContentArea() {
  const { sidebarTab, sidebarCollapsed } = useAppStore();

  return (
    <aside className={`sidebar-panel ${sidebarCollapsed ? "collapsed" : ""}`}>
      {sidebarTab === "projects" && <ProjectView />}
      <div className="sidebar-tab-view" hidden={sidebarTab !== "files"}>
        <FileExplorer />
      </div>
      {sidebarTab === "settings" && <SettingsView />}
    </aside>
  );
}
