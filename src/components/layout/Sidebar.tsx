import { useAppStore, type SidebarTab } from "@/stores/app-store";
import "../layout/Layout.css";

const tabs: { id: SidebarTab; label: string; icon: JSX.Element }[] = [
  {
    id: "projects",
    label: "项目",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "files",
    label: "资源管理器",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M4 6C4 4.89543 4.89543 4 6 4H10L12 7H18C19.1046 7 20 7.89543 20 9V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M4 10H20" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "设置",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M19.4 15C19.1277 15.6171 19.2583 16.3378 19.73 16.82L19.79 16.88C20.1656 17.2551 20.3766 17.7642 20.3766 18.295C20.3766 18.8258 20.1656 19.3349 19.79 19.71C19.4149 20.0856 18.9058 20.2966 18.375 20.2966C17.8442 20.2966 17.3351 20.0856 16.96 19.71L16.9 19.65C16.4178 19.1783 15.6971 19.0477 15.08 19.32C14.4755 19.5791 14.0826 20.1724 14.08 20.82V21C14.08 22.1046 13.1846 23 12.08 23C10.9754 23 10.08 22.1046 10.08 21V20.91C10.0642 20.2327 9.63587 19.6171 9 19.35C8.38291 19.0777 7.66219 19.2083 7.18 19.68L7.12 19.74C6.74493 20.1156 6.23588 20.3266 5.705 20.3266C5.17412 20.3266 4.66507 20.1156 4.29 19.74C3.91445 19.3649 3.70343 18.8558 3.70343 18.325C3.70343 17.7942 3.91445 17.2851 4.29 16.91L4.35 16.85C4.82167 16.3678 4.95231 15.6471 4.68 15.03C4.42094 14.4255 3.82764 14.0326 3.18 14.03H3C1.89543 14.03 1 13.1346 1 12.03C1 10.9254 1.89543 10.03 3 10.03H3.09C3.76727 10.0142 4.38291 9.58587 4.65 8.97C4.92231 8.35291 4.79167 7.63219 4.32 7.15L4.26 7.09C3.88445 6.71493 3.67343 6.20588 3.67343 5.675C3.67343 5.14412 3.88445 4.63507 4.26 4.26C4.63507 3.88445 5.14412 3.67343 5.675 3.67343C6.20588 3.67343 6.71493 3.88445 7.09 4.26L7.15 4.32C7.63219 4.79167 8.35291 4.92231 8.97 4.65C9.58587 4.37769 10.0142 3.76205 10.03 3.09V3C10.03 1.89543 10.9254 1 12.03 1C13.1346 1 14.03 1.89543 14.03 3V3.09C14.0458 3.76727 14.4742 4.38291 15.09 4.65C15.7071 4.92231 16.4278 4.79167 16.91 4.32L16.97 4.26C17.3451 3.88445 17.8541 3.67343 18.385 3.67343C18.9159 3.67343 19.4249 3.88445 19.8 4.26C20.1756 4.63507 20.3866 5.14412 20.3866 5.675C20.3866 6.20588 20.1756 6.71493 19.8 7.09L19.74 7.15C19.2683 7.63219 19.1377 8.35291 19.41 8.97C19.6741 9.58587 20.0977 10.0142 20.77 10.03H21C22.1046 10.03 23 10.9254 23 12.03C23 13.1346 22.1046 14.03 21 14.03H20.91C20.2327 14.0458 19.6171 14.4742 19.35 15.09L19.4 15Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const { sidebarTab, sidebarCollapsed, setSidebarTab, toggleSidebar } =
    useAppStore();

  return (
    <>
      <nav className="activity-bar">
        {tabs.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setSidebarTab(id)}
            title={label}
            className={`activity-btn ${sidebarTab === id ? "active" : ""}`}
          >
            {icon}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        <button
          onClick={toggleSidebar}
          title={sidebarCollapsed ? "展开侧边栏" : "收缩侧边栏"}
          className="activity-btn"
        >
          {sidebarCollapsed ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 4v16" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 10l2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 4v16" stroke="currentColor" strokeWidth="1.5" />
              <path d="M14 10l-2 2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </nav>
    </>
  );
}
