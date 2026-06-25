import { useEffect } from "react";
import { useProjectStore, type Project } from "@/stores/project-store";
import { useChatStore, type ChatMessage, type ModelInfo } from "@/stores/chat-store";

interface PersistedData {
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
}

interface PersistedMessages {
  sessionMessages: Record<string, ChatMessage[]>;
}

interface PersistedModel {
  currentModel: ModelInfo | null;
  thinkingLevel: string;
}

export function useDataPersistence() {
  // Load projects on mount
  useEffect(() => {
    window.electronAPI.loadData("projects").then((data) => {
      if (data && typeof data === "object" && "projects" in data) {
        const d = data as PersistedData;
        useProjectStore.setState({
          projects: d.projects,
          activeProjectId: d.activeProjectId || (d.projects.length > 0 ? d.projects[0].id : null),
          activeSessionId: d.activeSessionId || null,
        });
        // After loading projects, try to restore messages if sessionMessages is already loaded
        const sid = d.activeSessionId;
        if (sid) {
          const sm = useChatStore.getState().sessionMessages[sid];
          if (sm && sm.length > 0) {
            useChatStore.setState({ messages: sm });
          }
          // Restart agent process for the active session
          const project = d.projects.find((p) => p.sessions.some((s) => s.id === sid));
          const session = project?.sessions.find((s) => s.id === sid);
          if (project && session) {
            window.electronAPI.agentCreateSession(
              session.agentId, project.path, session.id, session.sessionFilePath
            );
          }
        }
      }
    });
  }, []);

  // Load session messages on mount
  useEffect(() => {
    window.electronAPI.loadData("sessionMessages").then((data) => {
      if (data && typeof data === "object" && "sessionMessages" in data) {
        const d = data as PersistedMessages;
        useChatStore.setState({ sessionMessages: d.sessionMessages });
        // After loading sessionMessages, try to restore messages if activeSessionId is already set
        const sid = useProjectStore.getState().activeSessionId;
        if (sid && d.sessionMessages[sid]) {
          useChatStore.setState({ messages: d.sessionMessages[sid] });
        }
      }
    });
  }, []);

  // Save projects, activeProjectId, and activeSessionId when they change
  useEffect(() => {
    const unsubscribe = useProjectStore.subscribe((state) => {
      window.electronAPI.saveData("projects", {
        projects: state.projects,
        activeProjectId: state.activeProjectId,
        activeSessionId: state.activeSessionId,
      });
    });
    return unsubscribe;
  }, []);

  // Save session messages when they change
  useEffect(() => {
    const unsubscribe = useChatStore.subscribe((state) => {
      window.electronAPI.saveData("sessionMessages", {
        sessionMessages: state.sessionMessages,
      });
    });
    return unsubscribe;
  }, []);

  // Load current model and thinking level on mount
  useEffect(() => {
    window.electronAPI.loadData("currentModel").then((data) => {
      if (data && typeof data === "object" && "currentModel" in data) {
        const d = data as PersistedModel;
        const updates: Record<string, unknown> = {};
        if (d.currentModel) {
          updates.currentModel = d.currentModel;
        }
        if (d.thinkingLevel) {
          updates.thinkingLevel = d.thinkingLevel;
        }
        if (Object.keys(updates).length > 0) {
          useChatStore.setState(updates as any);
        }
      }
    });
  }, []);

  // Save current model and thinking level when they change
  useEffect(() => {
    const unsubscribe = useChatStore.subscribe((state) => {
      window.electronAPI.saveData("currentModel", {
        currentModel: state.currentModel,
        thinkingLevel: state.thinkingLevel,
      });
    });
    return unsubscribe;
  }, []);
}
