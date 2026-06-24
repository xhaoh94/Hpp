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
      {sidebarTab === "files" && <FileExplorer />}
      {sidebarTab === "settings" && <SettingsView />}
    </aside>
  );
}
