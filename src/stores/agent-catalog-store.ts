import { create } from "zustand";
import type {
  AgentDescriptor,
  AgentPluginInstallResult,
  OfficialAgentPluginDescriptor,
} from "@/types";
import { normalizeAgentDisplayName, setAgentCatalog } from "@/lib/agents";

interface AgentCatalogState {
  agents: AgentDescriptor[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  officialPlugins: OfficialAgentPluginDescriptor[];
  officialLoading: boolean;
  officialLoaded: boolean;
  officialError: string | null;
  loadAgents: () => Promise<AgentDescriptor[]>;
  reloadAgents: () => Promise<AgentDescriptor[]>;
  installPluginFromPath: (pluginPath: string) => Promise<AgentPluginInstallResult>;
  loadOfficialPlugins: (force?: boolean) => Promise<OfficialAgentPluginDescriptor[]>;
  installOfficialPlugin: (agentId: string) => Promise<AgentPluginInstallResult>;
  removePlugin: (agentId: string, removeRuntime?: boolean) => Promise<AgentPluginInstallResult>;
}

function applyAgents(agents: AgentDescriptor[]) {
  const nextAgents = agents.map(normalizeAgentDisplayName);
  setAgentCatalog(nextAgents);
  return nextAgents;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useAgentCatalogStore = create<AgentCatalogState>((set, get) => ({
  agents: [],
  loading: false,
  loaded: false,
  error: null,
  officialPlugins: [],
  officialLoading: false,
  officialLoaded: false,
  officialError: null,

  loadAgents: async () => {
    const state = get();
    if (state.loaded) return state.agents;
    set({ loading: true, error: null });
    try {
      const agents = applyAgents(await window.electronAPI.agentList());
      set({ agents, loaded: true, loading: false, error: null });
      return agents;
    } catch (error) {
      const agents = applyAgents([]);
      set({ agents, loaded: true, loading: false, error: getErrorMessage(error) });
      return agents;
    }
  },

  reloadAgents: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.agentPluginReload();
      const agents = applyAgents(result.agents || await window.electronAPI.agentList());
      set({
        agents,
        loaded: true,
        loading: false,
        error: result.success ? null : result.error || "刷新插件失败",
      });
      return agents;
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error) });
      return get().agents;
    }
  },

  installPluginFromPath: async (pluginPath: string) => {
    const result = await window.electronAPI.agentPluginInstallFromPath(pluginPath);
    if (result.agents) {
      const agents = applyAgents(result.agents);
      set({ agents, loaded: true, error: result.success ? null : result.error || null });
    }
    return result;
  },

  loadOfficialPlugins: async (force = false) => {
    const state = get();
    if (state.officialLoaded && !force) return state.officialPlugins;
    set({ officialLoading: true, officialError: null });
    try {
      const result = await window.electronAPI.agentPluginListOfficial();
      set({
        officialPlugins: result.plugins.map(normalizeAgentDisplayName),
        officialLoaded: true,
        officialLoading: false,
        officialError: result.success ? null : result.error || "加载官方插件失败",
      });
      return result.plugins;
    } catch (error) {
      set({ officialLoading: false, officialError: getErrorMessage(error) });
      return get().officialPlugins;
    }
  },

  installOfficialPlugin: async (agentId: string) => {
    const result = await window.electronAPI.agentPluginInstallOfficial(agentId);
    if (result.agents) {
      const agents = applyAgents(result.agents);
      set({ agents, loaded: true, error: result.success ? null : result.error || null });
    }
    return result;
  },

  removePlugin: async (agentId: string, removeRuntime = false) => {
    const result = await window.electronAPI.agentPluginRemove(agentId, removeRuntime);
    if (result.agents) {
      const agents = applyAgents(result.agents);
      set({ agents, loaded: true, error: result.success ? null : result.error || null });
    }
    return result;
  },
}));
