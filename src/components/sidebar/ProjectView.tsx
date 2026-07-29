import { useState, useEffect, type DragEvent } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useAppStore } from "@/stores/app-store";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { ProjectCard } from "./ProjectCard";
import "./Sidebar.css";

export function ProjectView() {
  const { projects, addProject, reorderProjects } = useProjectStore();
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("before");
  const agents = useAgentCatalogStore((state) => state.agents);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);
  const { showAddProject, clearAddProject } = useAppStore();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

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

      <div className="sidebar-content">
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
                const movingDown = sourceIndex < targetIndex;
                const edgeSize = Math.min(28, rect.height * 0.22);
                const inInsertZone = movingDown
                  ? event.clientY >= rect.bottom - edgeSize
                  : event.clientY <= rect.top + edgeSize;
                if (!inInsertZone) {
                  setDropProjectId((current) => current === project.id ? null : current);
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropProjectId(project.id);
                setDropPosition(movingDown ? "after" : "before");
              }}
              onDragLeave={() => setDropProjectId((current) => current === project.id ? null : current)}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer.getData("text/plain") || draggedProjectId;
                if (sourceId) reorderProjects(sourceId, project.id, dropPosition === "after");
                setDraggedProjectId(null);
                setDropProjectId(null);
                setDropPosition("before");
              }}
              onDragEnd={() => {
                setDraggedProjectId(null);
                setDropProjectId(null);
                setDropPosition("before");
              }}
            >
              <ProjectCard project={project} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
