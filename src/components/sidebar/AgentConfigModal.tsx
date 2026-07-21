import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { CheckCircle2, Copy, CopyPlus, Eye, EyeOff, GripVertical, Loader2, Pencil, Plus, RefreshCw, Save, Search, Trash2, Undo2, X, Zap } from "lucide-react";
import type { AgentConfigState, AgentCustomModelConfig, AgentModel, AgentProviderConfig, AgentProviderConfiguration, AgentProviderEndpoint, AgentRemoteModel } from "@/types";
import { getAgentName } from "@/lib/agents";
import { useAgentCatalogStore } from "@/stores/agent-catalog-store";
import { useChatStore } from "@/stores/chat-store";
import { resolveCompatibleProviderEndpoint } from "@shared/agent-provider-copy";
import "./Settings.css";

type AgentConfigModalProps = {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onModelsUpdated: (agentId: string, models?: AgentModel[], selectedProviderId?: string) => void;
};

const emptyModel = (configuration?: AgentProviderConfiguration): AgentCustomModelConfig => ({
  id: "",
  name: "",
  reasoning: configuration?.modelDefaults.reasoning === true,
  imageInput: configuration?.modelDefaults.imageInput === true,
});

const createProvider = (index: number, configuration: AgentProviderConfiguration): AgentProviderConfig => ({
  providerId: `custom-${index}`,
  displayName: `Custom ${index}`,
  baseUrl: "",
  apiKey: "",
  authMode: configuration.defaultAuthMode || configuration.authModes?.[0]?.id || "bearer",
  endpoint: configuration.defaultEndpoint,
  models: [emptyModel(configuration)],
});

const getEndpointLabel = (configuration: AgentProviderConfiguration, endpoint: AgentProviderEndpoint) =>
  configuration.endpoints.find((option) => option.id === endpoint)?.label || endpoint;

function cloneProvider(provider: AgentProviderConfig): AgentProviderConfig {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  };
}

export function resolvePreferredProviderId(state: AgentConfigState, currentProviderId = ""): string {
  if (currentProviderId && state.providers.some((provider) => provider.providerId === currentProviderId)) {
    return currentProviderId;
  }
  if (state.activeProviderId && state.providers.some((provider) => provider.providerId === state.activeProviderId)) {
    return state.activeProviderId;
  }
  return state.providers[0]?.providerId || "";
}

export function AgentConfigModal({ agentId: initialAgentId, onClose, onModelsUpdated }: AgentConfigModalProps) {
  const [agentId, setAgentId] = useState(initialAgentId);
  const agents = useAgentCatalogStore((state) => state.agents);
  const loadAgents = useAgentCatalogStore((state) => state.loadAgents);
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const currentModelProvider = useChatStore((state) => state.currentModel?.provider);
  const configurableAgentList = useMemo(
    () => agents.filter((agent) => agent.capabilities.configuration !== "none"),
    [agents]
  );
  const activeAgent = configurableAgentList.find((agent) => agent.id === agentId);
  const providerConfiguration = activeAgent?.capabilities.configuration !== "none"
    ? activeAgent?.capabilities.configuration
    : undefined;
  const configurable = !!providerConfiguration;
  const usesActivation = activeAgent?.capabilities.providerActivation === "single-active";
  const endpointOptions = providerConfiguration?.endpoints || [];
  const authModeOptions = providerConfiguration?.authModes || [];
  const backendModelVisibility = providerConfiguration?.backendModelVisibility;
  const [config, setConfig] = useState<AgentConfigState>({ providers: [] });
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [draft, setDraft] = useState<AgentProviderConfig | null>(null);
  const [editorBaseline, setEditorBaseline] = useState<AgentProviderConfig | null>(null);
  const [editorOriginalProviderId, setEditorOriginalProviderId] = useState<string>("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activatingProviderId, setActivatingProviderId] = useState<string>("");
  const [deletingProviderId, setDeletingProviderId] = useState<string>("");
  const [deleteConfirmProvider, setDeleteConfirmProvider] = useState<AgentProviderConfig | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [backendModelsVisible, setBackendModelsVisible] = useState(true);
  const [savingModelVisibility, setSavingModelVisibility] = useState(false);
  const [reorderingProviderId, setReorderingProviderId] = useState<string>("");
  const [dragProviderId, setDragProviderId] = useState<string>("");
  const [dragOverProviderId, setDragOverProviderId] = useState<string>("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState("");
  const [remoteModels, setRemoteModels] = useState<AgentRemoteModel[]>([]);
  const [selectedRemoteModelIds, setSelectedRemoteModelIds] = useState<Set<string>>(new Set());
  const [modelSearch, setModelSearch] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copySourceProvider, setCopySourceProvider] = useState<AgentProviderConfig | null>(null);
  const [copyingTargetAgentId, setCopyingTargetAgentId] = useState("");
  const [copyProviderError, setCopyProviderError] = useState("");
  const apiKeyCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelFetchRequest = useRef(0);
  const providerItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    setAgentId(initialAgentId);
  }, [initialAgentId]);

  const selectedSavedProvider = useMemo(
    () => config.providers.find((provider) => provider.providerId === selectedProviderId) || null,
    [config.providers, selectedProviderId]
  );

  const providerCopyTargets = useMemo(() => {
    if (!copySourceProvider) return [];
    const orderedAgents = [
      ...configurableAgentList.filter((agent) => agent.id === agentId),
      ...configurableAgentList.filter((agent) => agent.id !== agentId),
    ];
    return orderedAgents.map((agent) => {
      const configuration = agent.capabilities.configuration === "none"
        ? undefined
        : agent.capabilities.configuration;
      const endpoint = configuration
        ? resolveCompatibleProviderEndpoint(copySourceProvider.endpoint, configuration.endpoints)
        : undefined;
      return { agent, configuration, endpoint };
    });
  }, [agentId, configurableAgentList, copySourceProvider]);

  const getPreferredProviderId = useCallback((state: AgentConfigState) => {
    const currentProviderId = agentId === activeAgentId ? currentModelProvider : "";
    return resolvePreferredProviderId(state, currentProviderId);
  }, [activeAgentId, agentId, currentModelProvider]);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    setActivatingProviderId("");
    setDeletingProviderId("");
    setDeleteConfirmProvider(null);
    setDeleteError("");
    setCopySourceProvider(null);
    setCopyingTargetAgentId("");
    setCopyProviderError("");
    setReorderingProviderId("");
    setDragProviderId("");
    setDragOverProviderId("");
    setApiKeyVisible(false);
    setApiKeyCopied(false);
    setBackendModelsVisible(backendModelVisibility?.defaultVisible ?? true);
    try {
      const result = await window.electronAPI.agentConfigList(agentId);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "读取配置失败" });
        return;
      }
      setConfig(result.config);
      setSelectedProviderId(getPreferredProviderId(result.config));
      setDraft(null);
      setEditorBaseline(null);
      setEditorOriginalProviderId("");
      setEditorOpen(false);
      if (backendModelVisibility?.userConfigurable) {
        const visibilityResult = await window.electronAPI.agentConfigGetModelVisibility(agentId);
        if (visibilityResult.success && typeof visibilityResult.backendModelsVisible === "boolean") {
          setBackendModelsVisible(visibilityResult.backendModelsVisible);
        } else if (!visibilityResult.success) {
          setStatus({ type: "error", text: visibilityResult.error || "读取模型显示设置失败" });
        }
      }
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [agentId, backendModelVisibility, getPreferredProviderId]);

  useEffect(() => {
    if (!configurable) {
      setLoading(false);
      return;
    }
    void loadConfig();
  }, [configurable, loadConfig]);

  useEffect(() => {
    setApiKeyCopied(false);
  }, [selectedSavedProvider]);

  useEffect(() => {
    if (loading || !selectedProviderId) return;
    const item = providerItemRefs.current[selectedProviderId];
    if (!item) return;
    const frame = requestAnimationFrame(() => {
      item.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, selectedProviderId, config.providers]);

  useEffect(() => {
    return () => {
      if (apiKeyCopyTimer.current) clearTimeout(apiKeyCopyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (editorOpen) return;
    modelFetchRequest.current += 1;
    setFetchingModels(false);
    setModelFetchError("");
    setRemoteModels([]);
    setSelectedRemoteModelIds(new Set());
    setModelSearch("");
    setModelPickerOpen(false);
  }, [editorOpen]);

  const configuredModelIds = useMemo(
    () => new Set((draft?.models || []).map((model) => model.id.trim()).filter(Boolean)),
    [draft?.models]
  );
  const filteredRemoteModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return remoteModels;
    return remoteModels.filter((model) =>
      model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)
    );
  }, [modelSearch, remoteModels]);
  const selectableFilteredModelIds = useMemo(
    () => filteredRemoteModels
      .filter((model) => !configuredModelIds.has(model.id))
      .map((model) => model.id),
    [configuredModelIds, filteredRemoteModels]
  );
  const allFilteredModelsSelected = selectableFilteredModelIds.length > 0 && selectableFilteredModelIds.every(
    (modelId) => selectedRemoteModelIds.has(modelId)
  );

  const handleReload = useCallback(async () => {
    setReloading(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentReloadConfig(agentId);
      if (!result.success) {
        setStatus({ type: "error", text: result.error || "重载配置失败" });
        return;
      }
      onModelsUpdated(agentId, result.models);
      const count = result.reloadedSessionIds?.length || 0;
      setStatus({
        type: "success",
        text: count > 0 ? `已重载 ${count} 个会话` : "暂无已初始化会话，下次启动会话时会读取新配置",
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setReloading(false);
    }
  }, [agentId, onModelsUpdated]);

  const handleBackendModelsVisibleChange = useCallback(async (visible: boolean) => {
    const previousVisible = backendModelsVisible;
    setBackendModelsVisible(visible);
    setSavingModelVisibility(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentConfigSetBackendModelsVisible(agentId, visible);
      if (!result.success) {
        setBackendModelsVisible(previousVisible);
        setStatus({ type: "error", text: result.error || "保存模型显示设置失败" });
        return;
      }
      if (result.models) onModelsUpdated(agentId, result.models);
      setStatus({
        type: "success",
        text: visible ? "已显示 Agent 内置模型" : "已仅显示自定义渠道模型",
      });
    } catch (error) {
      setBackendModelsVisible(previousVisible);
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSavingModelVisibility(false);
    }
  }, [agentId, backendModelsVisible, onModelsUpdated]);

  const handleAddProvider = useCallback(() => {
    if (!providerConfiguration) return;
    const existingIds = new Set(config.providers.map((provider) => provider.providerId));
    let index = config.providers.length + 1;
    while (existingIds.has(`custom-${index}`)) index += 1;
    const provider = createProvider(index, providerConfiguration);
    if (!usesActivation) setSelectedProviderId(provider.providerId);
    setDraft(provider);
    setEditorBaseline(cloneProvider(provider));
    setEditorOriginalProviderId("");
    setEditorOpen(true);
    setStatus(null);
  }, [config.providers, providerConfiguration, usesActivation]);

  const handleSelectProvider = useCallback((provider: AgentProviderConfig) => {
    setSelectedProviderId(provider.providerId);
    setStatus(null);
  }, []);

  const handleEditProvider = useCallback((provider: AgentProviderConfig) => {
    const nextDraft = cloneProvider(provider);
    setSelectedProviderId(provider.providerId);
    setDraft(nextDraft);
    setEditorBaseline(cloneProvider(nextDraft));
    setEditorOriginalProviderId(provider.providerId);
    setEditorOpen(true);
    setStatus(null);
  }, []);

  const handleOpenProviderCopy = useCallback((provider: AgentProviderConfig) => {
    setCopySourceProvider(cloneProvider(provider));
    setCopyingTargetAgentId("");
    setCopyProviderError("");
  }, []);

  const handleCopyToAgent = useCallback(async (targetAgentId: string) => {
    if (!copySourceProvider || copyingTargetAgentId) return;
    setCopyingTargetAgentId(targetAgentId);
    setCopyProviderError("");
    setStatus(null);
    try {
      const result = await window.electronAPI.agentConfigCopy(
        agentId,
        copySourceProvider.providerId,
        targetAgentId,
      );
      if (!result.success || !result.config) {
        setCopyProviderError(result.error || "复制渠道失败");
        return;
      }
      if (result.models) onModelsUpdated(targetAgentId, result.models);
      const targetAgent = configurableAgentList.find((agent) => agent.id === targetAgentId);
      const targetName = targetAgent?.name || targetAgentId;
      const copiedProviderId = result.copiedProviderId || copySourceProvider.providerId;
      const needsActivation = targetAgent?.capabilities.providerActivation === "single-active";
      setCopySourceProvider(null);
      setStatus({
        type: result.error ? "error" : "success",
        text: result.error
          ? `渠道已复制到 ${targetName}（${copiedProviderId}），但${result.error}`
          : needsActivation
            ? `渠道已复制到 ${targetName}（${copiedProviderId}），需要在目标 Agent 中启用`
            : `渠道已复制到 ${targetName}（${copiedProviderId}）`,
      });
    } catch (error) {
      setCopyProviderError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopyingTargetAgentId("");
    }
  }, [agentId, configurableAgentList, copyingTargetAgentId, copySourceProvider, onModelsUpdated]);

  const handleUndoDraft = useCallback(() => {
    if (!editorBaseline) return;
    setDraft(cloneProvider(editorBaseline));
    setApiKeyCopied(false);
    setStatus({ type: "success", text: "已撤销未保存改动" });
  }, [editorBaseline]);

  const updateDraft = useCallback((patch: Partial<AgentProviderConfig>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }, []);

  const updateModel = useCallback((index: number, patch: Partial<AgentCustomModelConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        models: current.models.map((model, modelIndex) =>
          modelIndex === index ? { ...model, ...patch } : model
        ),
      };
    });
  }, []);

  const addModel = useCallback(() => {
    setDraft((current) => current ? { ...current, models: [...current.models, emptyModel(providerConfiguration)] } : current);
  }, [providerConfiguration]);

  const handleFetchModels = useCallback(async () => {
    if (!draft) return;
    if (!draft.baseUrl.trim()) {
      setModelFetchError("请先填写渠道 URL。");
      return;
    }

    const requestId = ++modelFetchRequest.current;
    setFetchingModels(true);
    setModelFetchError("");
    try {
      const result = await window.electronAPI.agentConfigFetchModels(
        draft.baseUrl,
        draft.apiKey,
        draft.endpoint,
        draft.authMode,
      );
      if (modelFetchRequest.current !== requestId) return;
      if (!result.success || result.models.length === 0) {
        setModelFetchError(result.error || "没有获取到可用模型。");
        return;
      }
      setRemoteModels(result.models);
      setSelectedRemoteModelIds(new Set());
      setModelSearch("");
      setModelPickerOpen(true);
    } catch (error) {
      if (modelFetchRequest.current !== requestId) return;
      setModelFetchError(error instanceof Error ? error.message : String(error));
    } finally {
      if (modelFetchRequest.current === requestId) setFetchingModels(false);
    }
  }, [draft]);

  const toggleRemoteModel = useCallback((modelId: string) => {
    if (configuredModelIds.has(modelId)) return;
    setSelectedRemoteModelIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, [configuredModelIds]);

  const toggleAllFilteredModels = useCallback(() => {
    setSelectedRemoteModelIds((current) => {
      const next = new Set(current);
      if (allFilteredModelsSelected) {
        for (const modelId of selectableFilteredModelIds) next.delete(modelId);
      } else {
        for (const modelId of selectableFilteredModelIds) next.add(modelId);
      }
      return next;
    });
  }, [allFilteredModelsSelected, selectableFilteredModelIds]);

  const addSelectedRemoteModels = useCallback(() => {
    if (!draft) return;
    const selectedModels = remoteModels.filter((model) => selectedRemoteModelIds.has(model.id));
    if (selectedModels.length === 0) return;
    const existingIds = new Set(draft.models.map((model) => model.id.trim()).filter(Boolean));
    const additions = selectedModels.flatMap((model) => {
      if (existingIds.has(model.id)) return [];
      existingIds.add(model.id);
      return [{
        id: model.id,
        name: model.name || model.id,
        reasoning: providerConfiguration?.modelDefaults.reasoning === true,
        imageInput: providerConfiguration?.modelDefaults.imageInput === true,
      }];
    });
    if (additions.length === 0) return;
    const retainedModels = draft.models.filter((model) => model.id.trim() || model.name.trim());
    setDraft({ ...draft, models: [...retainedModels, ...additions] });
    setModelPickerOpen(false);
    setModelFetchError("");
    setStatus({ type: "success", text: `已添加 ${additions.length} 个模型到渠道草稿` });
  }, [draft, providerConfiguration, remoteModels, selectedRemoteModelIds]);

  const removeModel = useCallback((index: number) => {
    setDraft((current) => {
      if (!current || current.models.length <= 1) return current;
      return { ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    try {
      const normalizedDraft = {
        ...draft,
        providerId: draft.providerId.trim(),
        displayName: (draft.displayName || draft.providerId).trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        models: draft.models.map((model) => ({
          ...model,
          id: model.id.trim(),
          name: (model.name || model.id).trim(),
          reasoning: providerConfiguration?.fixedModelCapabilities
            ? providerConfiguration.modelDefaults.reasoning
            : model.reasoning,
          imageInput: providerConfiguration?.fixedModelCapabilities
            ? providerConfiguration.modelDefaults.imageInput
            : model.imageInput,
        })),
      };
      const payload = editorOriginalProviderId
        ? { ...normalizedDraft, originalProviderId: editorOriginalProviderId }
        : normalizedDraft;
      const result = await window.electronAPI.agentConfigSave(agentId, payload as AgentProviderConfig);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "保存配置失败" });
        return;
      }
      setConfig(result.config);
      const isNewProvider = !editorOriginalProviderId;
      const keepSelectedProviderId = selectedProviderId && result.config.providers.some((provider) =>
        provider.providerId === selectedProviderId
      );
      setSelectedProviderId(
        usesActivation && isNewProvider
          ? (keepSelectedProviderId ? selectedProviderId : result.config.providers[0]?.providerId || "")
          : normalizedDraft.providerId
      );
      setDraft(cloneProvider(normalizedDraft));
      setEditorBaseline(null);
      setEditorOriginalProviderId("");
      setEditorOpen(false);
      if (result.models) {
        onModelsUpdated(agentId, result.models);
      }
      const count = result.reloadedSessionIds?.length || 0;
      setStatus({
        type: "success",
        text: usesActivation
          ? normalizedDraft.providerId === result.config.activeProviderId
            ? "配置已保存，点击重新应用后写入本地配置并重载"
            : "配置已保存，点击启用后写入本地配置并重载"
          : result.error || (count > 0
            ? `本地配置已保存，已重载 ${count} 个会话`
            : "本地配置已保存，暂无已初始化会话"),
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }, [agentId, draft, editorOriginalProviderId, onModelsUpdated, providerConfiguration, selectedProviderId, usesActivation]);

  const handleActivate = useCallback(async (providerId: string) => {
    setActivatingProviderId(providerId);
    setStatus(null);
    try {
      const result = await window.electronAPI.agentConfigActivate(agentId, providerId);
      if (!result.success || !result.config) {
        setStatus({ type: "error", text: result.error || "启用渠道失败" });
        return;
      }
      setConfig(result.config);
      setSelectedProviderId(providerId);
      const provider = result.config.providers.find((item) => item.providerId === providerId);
      setDraft(provider ? cloneProvider(provider) : null);
      onModelsUpdated(agentId, result.models, providerId);
      const count = result.reloadedSessionIds?.length || 0;
      setStatus({
        type: "success",
        text: count > 0 ? "渠道已启用并完成重载" : "渠道已写入本地配置，下次启动会话时生效",
      });
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setActivatingProviderId("");
    }
  }, [agentId, onModelsUpdated]);

  const handleDelete = useCallback(async (providerId: string) => {
    const deletedIndex = config.providers.findIndex((provider) => provider.providerId === providerId);
    setDeletingProviderId(providerId);
    setDeleteError("");
    setStatus(null);
    try {
      const result = await window.electronAPI.agentConfigDelete(agentId, providerId);
      if (!result.success || !result.config) {
        setDeleteError(result.error || "删除渠道失败");
        return;
      }
      setConfig(result.config);
      const nextSelectedIndex = Math.min(
        Math.max(deletedIndex, 0),
        Math.max(result.config.providers.length - 1, 0)
      );
      const nextSelected = result.config.providers[nextSelectedIndex]?.providerId || "";
      setSelectedProviderId(nextSelected);
      setDraft(null);
      setEditorBaseline(null);
      setEditorOriginalProviderId("");
      setEditorOpen(false);
      setDeleteConfirmProvider(null);
      setDeleteError("");
      if (result.models) {
        onModelsUpdated(agentId, result.models);
      }
      setStatus({
        type: "success",
        text: usesActivation
          ? "渠道草稿已删除，当前启用的原生配置未被修改"
          : result.error || "渠道已从本地配置删除",
      });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingProviderId("");
    }
  }, [agentId, config.providers, onModelsUpdated, usesActivation]);

  const closeDeleteConfirm = useCallback(() => {
    if (deletingProviderId) return;
    setDeleteConfirmProvider(null);
    setDeleteError("");
  }, [deletingProviderId]);

  const handleProviderDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>, providerId: string) => {
    if (config.providers.length < 2 || reorderingProviderId) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", providerId);
    setDragProviderId(providerId);
    setDragOverProviderId("");
  }, [config.providers.length, reorderingProviderId]);

  const handleProviderDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>, providerId: string) => {
    if (!dragProviderId || dragProviderId === providerId || reorderingProviderId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverProviderId(providerId);
  }, [dragProviderId, reorderingProviderId]);

  const handleProviderDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>, providerId: string) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setDragOverProviderId((current) => current === providerId ? "" : current);
  }, []);

  const handleProviderDragEnd = useCallback(() => {
    setDragProviderId("");
    setDragOverProviderId("");
  }, []);

  const handleProviderDrop = useCallback(async (event: ReactDragEvent<HTMLDivElement>, targetProviderId: string) => {
    event.preventDefault();
    const sourceProviderId = event.dataTransfer.getData("text/plain") || dragProviderId;
    setDragProviderId("");
    setDragOverProviderId("");
    if (!sourceProviderId || sourceProviderId === targetProviderId || reorderingProviderId) return;

    const fromIndex = config.providers.findIndex((provider) => provider.providerId === sourceProviderId);
    const rawTargetIndex = config.providers.findIndex((provider) => provider.providerId === targetProviderId);
    if (fromIndex < 0 || rawTargetIndex < 0) return;

    const targetRect = event.currentTarget.getBoundingClientRect();
    const dropAfterTarget = event.clientY > targetRect.top + targetRect.height / 2;
    let targetIndex = rawTargetIndex + (dropAfterTarget ? 1 : 0);
    if (fromIndex < targetIndex) targetIndex -= 1;
    if (targetIndex === fromIndex) return;

    const previousConfig = config;
    const nextProviders = [...config.providers];
    const [movedProvider] = nextProviders.splice(fromIndex, 1);
    nextProviders.splice(targetIndex, 0, movedProvider);
    const nextConfig = { ...config, providers: nextProviders };
    const nextProviderIds = nextProviders.map((provider) => provider.providerId);

    setConfig(nextConfig);
    setStatus(null);
    setReorderingProviderId(sourceProviderId);

    try {
      const result = await window.electronAPI.agentConfigReorder(agentId, nextProviderIds);
      if (!result.success || !result.config) {
        setConfig(previousConfig);
        setStatus({ type: "error", text: result.error || "保存渠道顺序失败" });
        return;
      }
      setConfig(result.config);
      if (result.models) {
        onModelsUpdated(agentId, result.models);
      }
      setStatus({
        type: "success",
        text: result.error || "渠道顺序已保存",
      });
    } catch (error) {
      setConfig(previousConfig);
      setStatus({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setReorderingProviderId("");
    }
  }, [agentId, config, dragProviderId, onModelsUpdated, reorderingProviderId]);

  const handleCopyApiKey = useCallback(async () => {
    const apiKey = draft?.apiKey || "";
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setApiKeyCopied(true);
      if (apiKeyCopyTimer.current) clearTimeout(apiKeyCopyTimer.current);
      apiKeyCopyTimer.current = setTimeout(() => setApiKeyCopied(false), 1200);
    } catch (error) {
      setStatus({ type: "error", text: error instanceof Error ? error.message : "复制 sk-key 失败" });
    }
  }, [draft?.apiKey]);

  return (
    <div className="settings-modal-overlay agent-config-modal-overlay" onMouseDown={onClose}>
      <div className="settings-modal agent-config-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-modal-header agent-config-header">
          <div className="agent-config-header-main">
            <div className="agent-config-title-row">
              <h3>{getAgentName(agentId)} 配置</h3>
            </div>
            <div className="agent-config-subtitle">{providerConfiguration?.pathLabel || "Agent provider config"}</div>
            <div className="agent-config-tabs" role="tablist" aria-label="Agent 配置切换">
              {configurableAgentList.map((agent) => {
                const active = agent.id === agentId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`agent-config-tab ${active ? "active" : ""}`}
                    onClick={() => setAgentId(agent.id)}
                  >
                    {agent.name}
                  </button>
                );
              })}
            </div>
          </div>
          <button type="button" className="settings-modal-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="settings-modal-content agent-config-content">
          <div className="agent-config-toolbar">
            <span>{providerConfiguration?.hint || ""}</span>
            <div className="agent-config-toolbar-actions">
              {backendModelVisibility?.userConfigurable && (
                <label
                  className="agent-config-model-visibility"
                  title={backendModelVisibility.description}
                >
                  <span>{backendModelVisibility.label}</span>
                  <input
                    type="checkbox"
                    checked={backendModelsVisible}
                    disabled={loading || savingModelVisibility}
                    onChange={(event) => void handleBackendModelsVisibleChange(event.target.checked)}
                  />
                </label>
              )}
              <button type="button" className="btn-action" onClick={handleReload} disabled={reloading}>
                <RefreshCw size={13} />
                {reloading ? "重载中..." : "重新载入当前配置"}
              </button>
            </div>
          </div>

          {!configurable ? (
            <div className="agent-config-empty">
              当前 Agent 暂不支持自定义渠道配置。
            </div>
          ) : loading ? (
            <div className="agent-config-empty">读取配置中...</div>
          ) : (
            <div className="agent-config-grid">
              <aside className="agent-config-provider-list">
                <div className="agent-config-section-title">渠道</div>
                <div className="agent-config-provider-scroll">
                  {config.providers.length === 0 && (
                    <div className="agent-config-empty compact">暂无渠道</div>
                  )}
                  {config.providers.map((provider) => {
                    const active = usesActivation && provider.providerId === config.activeProviderId;
                    const selected = provider.providerId === selectedProviderId;
                    const activating = activatingProviderId === provider.providerId;
                    const dragging = dragProviderId === provider.providerId;
                    const dropTarget = dragOverProviderId === provider.providerId;
                    const reordering = reorderingProviderId === provider.providerId;
                    const title = provider.displayName || provider.providerId;
                    const initial = title.trim().slice(0, 1).toUpperCase() || "C";
                    return (
                      <div
                        key={provider.providerId}
                        ref={(element) => {
                          providerItemRefs.current[provider.providerId] = element;
                        }}
                        className={`agent-config-provider-item ${selected ? "selected" : ""} ${active ? "active" : ""} ${dragging ? "dragging" : ""} ${dropTarget ? "drop-target" : ""} ${reordering ? "reordering" : ""}`}
                        draggable={config.providers.length > 1 && !reorderingProviderId}
                        onDragStart={(event) => handleProviderDragStart(event, provider.providerId)}
                        onDragOver={(event) => handleProviderDragOver(event, provider.providerId)}
                        onDragLeave={(event) => handleProviderDragLeave(event, provider.providerId)}
                        onDrop={(event) => void handleProviderDrop(event, provider.providerId)}
                        onDragEnd={handleProviderDragEnd}
                        onClick={() => handleSelectProvider(provider)}
                      >
                        <span className="agent-config-provider-drag" title="拖动调整渠道顺序" aria-hidden="true">
                          <GripVertical size={14} />
                        </span>
                        <div className="agent-config-provider-avatar">{initial}</div>
                        <div className="agent-config-provider-main">
                          <div className="agent-config-provider-title-line">
                            <span className="agent-config-provider-name">{title}</span>
                            {active && <CheckCircle2 size={13} className="agent-config-provider-check" />}
                          </div>
                          <span className="agent-config-provider-url">{provider.baseUrl || "未配置 URL"}</span>
                          <span className="agent-config-provider-id">
                            {provider.providerId} · {provider.models.length} 个模型
                          </span>
                        </div>
                        {usesActivation && (
                          <div className="agent-config-provider-actions">
                            {active ? (
                              <span className="agent-config-active-badge">当前</span>
                            ) : (
                              <button
                                type="button"
                                className="btn-action agent-config-mini-btn"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleActivate(provider.providerId);
                                }}
                                disabled={!!activatingProviderId || !!reorderingProviderId}
                              >
                                {activating ? "启用中..." : "启用"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="filter-add-btn agent-config-add-provider" onClick={handleAddProvider} disabled={!!reorderingProviderId}>
                  <Plus size={13} />
                  新增渠道
                </button>
              </aside>

              <section className="agent-config-form">
                {!selectedSavedProvider ? (
                  <div className="agent-config-empty">选择左侧渠道，或新增一个渠道</div>
                ) : (
                  <>
                    <div className="agent-config-form-header">
                      <div className="agent-config-section-title">渠道配置</div>
                      <div className="agent-config-form-actions">
                        <button
                          type="button"
                          className="btn-action"
                          onClick={() => handleEditProvider(selectedSavedProvider)}
                        >
                          <Pencil size={13} />
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn-action"
                          onClick={() => handleOpenProviderCopy(selectedSavedProvider)}
                        >
                          <Copy size={13} />
                          复制
                        </button>
                        <button
                          type="button"
                          className="btn-action"
                          onClick={() => {
                            setDeleteError("");
                            setDeleteConfirmProvider(cloneProvider(selectedSavedProvider));
                          }}
                          disabled={!!deletingProviderId || !!reorderingProviderId || (usesActivation && selectedSavedProvider.providerId === config.activeProviderId)}
                          title={usesActivation && selectedSavedProvider.providerId === config.activeProviderId ? "请先启用其它渠道再删除当前渠道" : undefined}
                        >
                          <Trash2 size={13} />
                          {deletingProviderId ? "删除中..." : "删除"}
                        </button>
                      </div>
                    </div>

                    <div className="agent-config-summary">
                      <div className="agent-config-summary-row">
                        <span>渠道 ID</span>
                        <strong>{selectedSavedProvider.providerId}</strong>
                      </div>
                      <div className="agent-config-summary-row">
                        <span>显示名</span>
                        <strong>{selectedSavedProvider.displayName || selectedSavedProvider.providerId}</strong>
                      </div>
                      <div className="agent-config-summary-row wide">
                        <span>渠道 URL</span>
                        <strong>{selectedSavedProvider.baseUrl || "未配置"}</strong>
                      </div>
                      <div className="agent-config-summary-row">
                        <span>Endpoint</span>
                        <strong>{providerConfiguration ? getEndpointLabel(providerConfiguration, selectedSavedProvider.endpoint) : selectedSavedProvider.endpoint}</strong>
                      </div>
                      {authModeOptions.length > 1 && (
                        <div className="agent-config-summary-row">
                          <span>鉴权方式</span>
                          <strong>{authModeOptions.find((option) => option.id === selectedSavedProvider.authMode)?.label || selectedSavedProvider.authMode}</strong>
                        </div>
                      )}
                      <div className="agent-config-summary-row">
                        <span>模型数量</span>
                        <strong>{selectedSavedProvider.models.length}</strong>
                      </div>
                    </div>

                    <div className="agent-config-summary-models">
                      <div className="agent-config-section-title">模型</div>
                      {selectedSavedProvider.models.length === 0 ? (
                        <div className="agent-config-empty compact">暂无模型</div>
                      ) : (
                        selectedSavedProvider.models.map((model) => (
                          <div key={model.id} className="agent-config-summary-model">
                            <span>{model.name || model.id}</span>
                            <code>{model.id}</code>
                          </div>
                        ))
                      )}
                    </div>
                    {usesActivation && (
                      <button
                        type="button"
                        className="filter-add-btn agent-config-activate-wide"
                        onClick={() => void handleActivate(selectedSavedProvider.providerId)}
                        disabled={!!activatingProviderId || !!reorderingProviderId}
                      >
                        <Zap size={13} />
                        {activatingProviderId
                          ? "启用中..."
                          : selectedSavedProvider.providerId === config.activeProviderId
                            ? "重新应用当前渠道并重载"
                            : "启用此渠道并重载"}
                      </button>
                    )}
                  </>
                )}
              </section>
            </div>
          )}

          {status && (
            <div className={`status-message ${status.type}`}>
              {status.text}
            </div>
          )}
        </div>
      </div>
      {editorOpen && draft && (
        <div
          className="settings-modal-overlay agent-provider-editor-overlay"
          onMouseDown={(event) => {
            event.stopPropagation();
            setEditorOpen(false);
          }}
        >
          <div className="settings-modal agent-provider-editor-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>{editorOriginalProviderId ? "编辑渠道" : "新增渠道"}</h3>
                <div className="agent-config-subtitle">{draft.providerId || "new-provider"}</div>
              </div>
              <div className="agent-config-form-actions">
                <button
                  type="button"
                  className="btn-action"
                  onClick={handleUndoDraft}
                  disabled={!editorBaseline}
                >
                  <Undo2 size={13} />
                  撤销
                </button>
                <button type="button" className="filter-add-btn agent-config-save-btn" onClick={() => void handleSave()} disabled={saving}>
                  <Save size={13} />
                  {saving ? "保存中..." : "保存"}
                </button>
                <button
                  type="button"
                  className="settings-modal-close"
                  onClick={() => setEditorOpen(false)}
                  aria-label="关闭"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="settings-modal-content agent-provider-editor-content">
              <div className="agent-config-fields">
                <label>
                  <span>渠道 ID</span>
                  <input
                    value={draft.providerId}
                    onChange={(event) => updateDraft({ providerId: event.target.value })}
                    className="input-field"
                    placeholder="my-provider"
                  />
                </label>
                <label>
                  <span>显示名</span>
                  <input
                    value={draft.displayName}
                    onChange={(event) => updateDraft({ displayName: event.target.value })}
                    className="input-field"
                    placeholder="My Provider"
                  />
                </label>
                <label>
                  <span>渠道 URL</span>
                  <input
                    value={draft.baseUrl}
                    onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                    className="input-field"
                    placeholder={draft.endpoint === "anthropic-messages"
                      ? "https://api.anthropic.com"
                      : "https://api.example.com/v1"}
                  />
                </label>
                <label>
                  <span>Endpoint</span>
                  <select
                    value={draft.endpoint}
                    onChange={(event) => updateDraft({ endpoint: event.target.value as AgentProviderEndpoint })}
                    className="input-field"
                  >
                    {endpointOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {authModeOptions.length > 1 && (
                  <label>
                    <span>鉴权方式</span>
                    <select
                      value={draft.authMode}
                      onChange={(event) => updateDraft({ authMode: event.target.value as AgentProviderConfig["authMode"] })}
                      className="input-field"
                    >
                      {authModeOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="agent-config-field-wide">
                  <span>sk-key</span>
                  <div className="agent-config-secret-input">
                    <input
                      value={draft.apiKey}
                      onChange={(event) => {
                        updateDraft({ apiKey: event.target.value });
                        setApiKeyCopied(false);
                      }}
                      className="input-field"
                      placeholder="sk-..."
                      type={apiKeyVisible ? "text" : "password"}
                    />
                    <button
                      type="button"
                      className="btn-icon agent-config-secret-btn"
                      onClick={() => setApiKeyVisible((visible) => !visible)}
                      title={apiKeyVisible ? "隐藏 sk-key" : "显示 sk-key"}
                      aria-label={apiKeyVisible ? "隐藏 sk-key" : "显示 sk-key"}
                    >
                      {apiKeyVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      type="button"
                      className={`btn-icon agent-config-secret-btn ${apiKeyCopied ? "copied" : ""}`}
                      onClick={() => void handleCopyApiKey()}
                      disabled={!draft.apiKey}
                      title="复制 sk-key"
                      aria-label="复制 sk-key"
                    >
                      {apiKeyCopied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </label>
              </div>

              <div className="agent-config-models-header">
                <div className="agent-config-section-title">模型</div>
                <div className="agent-config-model-actions">
                  <button
                    type="button"
                    className="btn-action agent-config-mini-btn"
                    onClick={() => void handleFetchModels()}
                    disabled={fetchingModels || !draft.baseUrl.trim()}
                  >
                    {fetchingModels ? <Loader2 size={13} className="agent-config-spin" /> : <RefreshCw size={13} />}
                    {fetchingModels ? "获取中..." : "获取模型"}
                  </button>
                  <button type="button" className="btn-action agent-config-mini-btn" onClick={addModel}>
                    <Plus size={13} />
                    添加模型
                  </button>
                </div>
              </div>
              {modelFetchError && <div className="status-message error agent-config-fetch-error">{modelFetchError}</div>}
              <div className="agent-config-model-list">
                {draft.models.map((model, index) => (
                  <div key={index} className="agent-config-model-row">
                    <input
                      value={model.id}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                      className="input-field"
                      placeholder="model-id"
                    />
                    <input
                      value={model.name}
                      onChange={(event) => updateModel(index, { name: event.target.value })}
                      className="input-field"
                      placeholder="显示名"
                    />
                    <label className="agent-config-check">
                      <input
                        type="checkbox"
                        checked={model.reasoning}
                        onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
                        disabled={providerConfiguration?.fixedModelCapabilities}
                      />
                      Reasoning
                    </label>
                    <label className="agent-config-check">
                      <input
                        type="checkbox"
                        checked={model.imageInput}
                        onChange={(event) => updateModel(index, { imageInput: event.target.checked })}
                        disabled={providerConfiguration?.fixedModelCapabilities}
                      />
                      图片
                    </label>
                    <button
                      type="button"
                      className="btn-icon btn-delete"
                      onClick={() => removeModel(index)}
                      disabled={draft.models.length <= 1}
                      title="删除模型"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {modelPickerOpen && draft && (
        <div
          className="settings-modal-overlay agent-model-picker-overlay"
          onMouseDown={(event) => {
            event.stopPropagation();
            setModelPickerOpen(false);
          }}
        >
          <div className="settings-modal agent-model-picker-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>选择模型</h3>
                <div className="agent-config-subtitle">{draft.displayName || draft.providerId} · {remoteModels.length} 个模型</div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setModelPickerOpen(false)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="settings-modal-content agent-model-picker-content">
              <div className="agent-model-picker-search">
                <Search size={14} />
                <input
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  className="input-field"
                  placeholder="搜索模型 ID 或名称"
                  autoFocus
                />
              </div>
              <div className="agent-model-picker-toolbar">
                <span>已选择 {selectedRemoteModelIds.size} 个</span>
                <button
                  type="button"
                  className="btn-action agent-config-mini-btn"
                  onClick={toggleAllFilteredModels}
                  disabled={selectableFilteredModelIds.length === 0}
                >
                  {allFilteredModelsSelected ? "清空结果" : "全选结果"}
                </button>
              </div>
              <div className="agent-model-picker-list">
                {filteredRemoteModels.length === 0 ? (
                  <div className="agent-config-empty">没有匹配的模型</div>
                ) : filteredRemoteModels.map((model) => {
                  const configured = configuredModelIds.has(model.id);
                  return (
                    <label key={model.id} className={`agent-model-picker-row ${configured ? "configured" : ""}`}>
                      <input
                        type="checkbox"
                        checked={configured || selectedRemoteModelIds.has(model.id)}
                        onChange={() => toggleRemoteModel(model.id)}
                        disabled={configured}
                      />
                      <span className="agent-model-picker-name">{model.name}</span>
                      <code>{model.id}</code>
                      {configured && <span className="agent-model-picker-badge">已添加</span>}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="agent-model-picker-footer">
              <button type="button" className="btn-action" onClick={() => setModelPickerOpen(false)}>取消</button>
              <button
                type="button"
                className="filter-add-btn"
                onClick={addSelectedRemoteModels}
                disabled={selectedRemoteModelIds.size === 0}
              >
                <Plus size={13} />
                添加已选（{selectedRemoteModelIds.size}）
              </button>
            </div>
          </div>
        </div>
      )}
      {copySourceProvider && (
        <div
          className="settings-modal-overlay agent-provider-copy-overlay"
          onMouseDown={() => {
            if (!copyingTargetAgentId) setCopySourceProvider(null);
          }}
        >
          <div className="settings-modal agent-provider-copy-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>复制渠道到 Agent</h3>
                <div className="agent-config-subtitle">{copySourceProvider.displayName || copySourceProvider.providerId}</div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setCopySourceProvider(null)}
                disabled={!!copyingTargetAgentId}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="settings-modal-content agent-provider-copy-content">
              <div className="agent-provider-copy-source">
                <span>来源</span>
                <strong>{getAgentName(agentId)}</strong>
                <code>{copySourceProvider.providerId}</code>
              </div>
              <div className="agent-provider-copy-list">
                {providerCopyTargets.length === 0 ? (
                  <div className="agent-config-empty">没有可用的复制目标</div>
                ) : providerCopyTargets.map(({ agent, configuration, endpoint }) => {
                  const endpointLabel = endpoint
                    ? configuration?.endpoints.find((option) => option.id === endpoint)?.label || endpoint
                    : `不支持 ${copySourceProvider.endpoint}`;
                  const copying = copyingTargetAgentId === agent.id;
                  const isCurrentAgent = agent.id === agentId;
                  return (
                    <div key={agent.id} className={`agent-provider-copy-row ${endpoint ? "" : "incompatible"}`}>
                      <div className="agent-provider-copy-avatar">{(agent.shortName || agent.name || agent.id).slice(0, 2).toUpperCase()}</div>
                      <div className="agent-provider-copy-main">
                        <div className="agent-provider-copy-title">
                          <strong>{agent.name}</strong>
                          {isCurrentAgent && <span className="agent-provider-copy-current">当前</span>}
                        </div>
                        <span>{endpointLabel}</span>
                      </div>
                      <button
                        type="button"
                        className="btn-action agent-provider-copy-btn"
                        onClick={() => void handleCopyToAgent(agent.id)}
                        disabled={!endpoint || !!copyingTargetAgentId}
                      >
                        {copying ? <Loader2 size={13} className="agent-config-spin" /> : <CopyPlus size={13} />}
                        {copying ? "复制中..." : isCurrentAgent ? "复制到当前" : "复制"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {copyProviderError && <div className="status-message error agent-provider-copy-error">{copyProviderError}</div>}
            </div>
          </div>
        </div>
      )}
      {deleteConfirmProvider && (
        <div className="settings-modal-overlay agent-provider-delete-overlay" onMouseDown={closeDeleteConfirm}>
          <div className="settings-modal agent-remove-confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <h3>删除渠道</h3>
                <div className="agent-config-subtitle">{deleteConfirmProvider.providerId}</div>
              </div>
              <button
                type="button"
                className="settings-modal-close"
                onClick={closeDeleteConfirm}
                disabled={!!deletingProviderId}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-modal-content agent-remove-confirm-content">
              <p>确定删除渠道“{deleteConfirmProvider.displayName || deleteConfirmProvider.providerId}”吗？</p>
              <div className="agent-provider-delete-target">
                <span>渠道 ID</span>
                <code>{deleteConfirmProvider.providerId}</code>
              </div>
              {deleteError && <div className="status-message error agent-provider-delete-error">{deleteError}</div>}
              <div className="agent-remove-confirm-actions">
                <button type="button" className="btn-action" onClick={closeDeleteConfirm} disabled={!!deletingProviderId}>
                  取消
                </button>
                <button
                  type="button"
                  className="filter-add-btn"
                  onClick={() => void handleDelete(deleteConfirmProvider.providerId)}
                  disabled={!!deletingProviderId}
                >
                  <Trash2 size={13} />
                  {deletingProviderId ? "删除中..." : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
