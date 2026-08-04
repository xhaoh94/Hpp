import { useState, useEffect, useRef, type DragEvent } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useDragAutoScroll } from "@/hooks/useDragAutoScroll";
import { ProjectCard } from "./ProjectCard";
import "./Sidebar.css";

export function ProjectView() {
  const { projects, activeSessionId, projectDataHydrated, addProject, reorderProjects } = useProjectStore();
  const startupCollapseStateRef = useRef<Map<string, boolean> | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("before");
  const projectScrollRef = useRef<HTMLDivElement>(null);
  const { update: updateProjectAutoScroll, stop: stopProjectAutoScroll } = useDragAutoScroll(projectScrollRef);
  const agents = useAgentCatalogStore((state) => state.agents);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);
  const { showAddProject, clearAddProject } = useAppStore();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  if (projectDataHydrated && startupCollapseStateRef.current === null) {
    const rememberedProjectId = projects.find((project) =>
      project.sessions.some((session) => session.id === activeSessionId)
    )?.id;
    startupCollapseStateRef.current = new Map(
      projects.map((project) => [project.id, project.id !== rememberedProjectId]),
    );
  }

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (showAddProject) {
      setShowAdd(true);
      clearAddProject();
    }
  }, [showAddProject]);

  const handleAdd = () => {
    if (!name.trim() || !path.trim()) return;
    addProject(name.trim(), path.trim(), agents.map((agent) => agent.id));
    setName("");
    setPath("");
    setShowAdd(false);
  };

  const handleBrowse = async () => {
    const result = await window.electronAPI.openDirectory();
    if (!result.canceled && result.path) {
      setPath(result.path);
      if (!name.trim()) {
        // Auto-fill name from directory name
        const dirName = result.path.split(/[/\\]/).pop() || "";
        setName(dirName);
      }
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>项目</span>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-add">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {showAdd && (
        <div className="project-form">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="项目名称"
            autoFocus
            className="input-field"
          />
          <div className="path-input-row">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="项目路径"
              className="input-field path-input"
            />
            <button onClick={handleBrowse} className="btn-browse">浏览</button>
          </div>
          <div className="form-actions">
            <button onClick={() => setShowAdd(false)} className="btn btn-cancel">取消</button>
            <button onClick={handleAdd} className="btn btn-primary">添加</button>
          </div>
        </div>
      )}

      <div
        ref={projectScrollRef}
        className="sidebar-content"
        onDragOver={(event) => {
          if (draggedProjectId) updateProjectAutoScroll(event.clientY);
        }}
        onDrop={stopProjectAutoScroll}
      >
        {projects.length === 0 && !showAdd && (
          <div className="placeholder-text">暂无项目</div>
        )}
        <div className="project-list">
          {projects.map((project) => (
            <div
              key={project.id}
              className={`project-card-drag-wrapper ${draggedProjectId === project.id ? "dragging" : ""} ${dropProjectId === project.id ? `drop-target ${dropPosition}` : ""}`}
              draggable={projects.length > 1}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                stopProjectAutoScroll();
                setDraggedProjectId(project.id);
                setDropPosition("before");
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", project.id);
              }}
              onDragOver={(event) => {
                if (!draggedProjectId || draggedProjectId === project.id) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const sourceIndex = projects.findIndex((item) => item.id === draggedProjectId);
                const targetIndex = projects.findIndex((item) => item.id === project.id);
                const insertAfter = event.clientY >= rect.top + rect.height / 2;
                const rawInsertIndex = targetIndex + (insertAfter ? 1 : 0);
                const nextIndex = sourceIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex;
                if (sourceIndex < 0 || targetIndex < 0 || nextIndex === sourceIndex) {
                  setDropProjectId((current) => current === project.id ? null : current);
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropProjectId(project.id);
                setDropPosition(insertAfter ? "after" : "before");
              }}
              onDragLeave={(event) => {
                const relatedTarget = event.relatedTarget;
                if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
                setDropProjectId((current) => current === project.id ? null : current);
              }}
              onDrop={(event) => {
                event.preventDefault();
                stopProjectAutoScroll();
                const sourceId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                if (sourceId && dropProjectId === project.id) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const insertAfter = event.clientY >= rect.top + rect.height / 2;
                  reorderProjects(sourceId, project.id, insertAfter);
                }
                setDraggedProjectId(null);
                setDropProjectId(null);
                setDropPosition("before");
              }}
              onDragEnd={() => {
                stopProjectAutoScroll();
                setDraggedProjectId(null);
                setDropProjectId(null);
                setDropPosition("before");
              }}
            >
              <ProjectCard
                project={project}
                initialSessionsCollapsed={startupCollapseStateRef.current?.get(project.id) ?? false}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
