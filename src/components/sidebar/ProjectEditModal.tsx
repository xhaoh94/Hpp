import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { Project } from "@/stores/project-store";
import { isDefaultWorkspaceProject } from "@/lib/default-workspace";

interface Props {
  project: Project;
  onClose: () => void;
  onSubmit: (patch: { name: string; path: string }) => void;
}

/** 项目卡片改名 / 改路径弹窗。内置工作区只能改路径，名字是固定文案。 */
export function ProjectEditModal({ project, onClose, onSubmit }: Props) {
  const nameLocked = isDefaultWorkspaceProject(project);
  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleBrowse = async () => {
    const result = await window.electronAPI.openDirectory();
    if (!result.canceled && result.path) setPath(result.path);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextName = nameLocked ? project.name : name.trim();
    const nextPath = path.trim();
    if (!nextPath || (!nameLocked && !nextName)) return;
    onSubmit({ name: nextName, path: nextPath });
    onClose();
  };

  return createPortal(
    <div
      className="project-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="project-form project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-project-title"
        onSubmit={handleSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="project-modal-header">
          <div>
            <h2 id="edit-project-title">编辑项目</h2>
            <p>{nameLocked ? "默认工作区名称固定，可修改工作目录" : "修改项目名称与目录地址"}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="project-modal-close"
            aria-label="关闭编辑项目弹窗"
            title="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="project-modal-body">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="项目名称"
            aria-label="项目名称"
            className="input-field"
            disabled={nameLocked}
            autoFocus={!nameLocked}
          />
          <div className="path-input-row">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="项目路径"
              aria-label="项目路径"
              className="input-field path-input"
              autoFocus={nameLocked}
            />
            <button type="button" onClick={handleBrowse} className="btn-browse">浏览</button>
          </div>
          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn btn-cancel">取消</button>
            <button type="submit" className="btn btn-primary">保存</button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
