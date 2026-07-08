import { useMemo, type ReactNode, type RefObject } from "react";
import { Settings } from "lucide-react";
import type { ModelInfo } from "@/stores/chat-store";
import { getAgentName } from "@/lib/agents";

type ThinkingLevelOption = {
  id: string;
  label: string;
};

type ChatToolbarProps = {
  activeAgentId: string;
  activeSessionAgentId?: string;
  availableModels: ModelInfo[];
  currentModel: ModelInfo | null;
  currentThinking: ThinkingLevelOption;
  expandedProvider: string | null;
  favoriteModels: ModelInfo[];
  modelOpen: boolean;
  modelProviders: string[];
  planModeEnabled: boolean;
  thinkingLevel: string;
  thinkingLevels: ThinkingLevelOption[];
  thinkingOpen: boolean;
  modelRef: RefObject<HTMLDivElement | null>;
  thinkingRef: RefObject<HTMLDivElement | null>;
  leadingContent?: ReactNode;
  getPlanModeTooltip: (agentId: string) => string;
  onExpandedProviderChange: (provider: string | null) => void;
  onModelOpenChange: (open: boolean) => void;
  onThinkingOpenChange: (open: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  onOpenModelConfig: () => void;
  onSelectModel: (model: ModelInfo) => void;
  onSelectThinking: (levelId: string) => void;
  onToggleFavorite: (model: ModelInfo) => void;
};

export function ChatToolbar({
  activeAgentId,
  activeSessionAgentId,
  availableModels,
  currentModel,
  currentThinking,
  expandedProvider,
  favoriteModels,
  modelOpen,
  modelProviders,
  planModeEnabled,
  thinkingLevel,
  thinkingLevels,
  thinkingOpen,
  modelRef,
  thinkingRef,
  leadingContent,
  getPlanModeTooltip,
  onExpandedProviderChange,
  onModelOpenChange,
  onThinkingOpenChange,
  onPlanModeChange,
  onOpenModelConfig,
  onSelectModel,
  onSelectThinking,
  onToggleFavorite,
}: ChatToolbarProps) {
  const agentId = activeSessionAgentId || activeAgentId;
  const favoriteModelKeys = useMemo(
    () => new Set(favoriteModels.map((model) => `${model.provider}:${model.id}`)),
    [favoriteModels]
  );
  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ModelInfo[]>();
    for (const model of availableModels) {
      const providerModels = grouped.get(model.provider);
      if (providerModels) providerModels.push(model);
      else grouped.set(model.provider, [model]);
    }
    return grouped;
  }, [availableModels]);
  const isFavoriteModel = (model: ModelInfo) => favoriteModelKeys.has(`${model.provider}:${model.id}`);

  return (
    <div className="chat-input-toolbar">
      {leadingContent}

      <button
        type="button"
        onClick={() => onPlanModeChange(!planModeEnabled)}
        className={`chat-toolbar-select chat-toolbar-plan-toggle ${planModeEnabled ? "active" : ""}`}
        title={getPlanModeTooltip(agentId)}
        aria-pressed={planModeEnabled}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 6h11" />
          <path d="M9 12h11" />
          <path d="M9 18h11" />
          <path d="M4 6l1 1 2-2" />
          <path d="M4 12l1 1 2-2" />
          <path d="M4 18l1 1 2-2" />
        </svg>
        <span>Plan</span>
      </button>

      <div ref={modelRef} className="relative">
        <button
          onClick={() => {
            onModelOpenChange(!modelOpen);
            onThinkingOpenChange(false);
            if (modelOpen) onExpandedProviderChange(null);
          }}
          className="chat-toolbar-select"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <circle cx="15.5" cy="8.5" r="1.5" />
            <path d="M8 14c0 0 1.5 2 4 2s4-2 4-2" />
          </svg>
          <span>{currentModel?.name || "选择模型"}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {modelOpen && (
          <div className="chat-dropdown">
            <div className="chat-model-dropdown-header">
              <span className="chat-model-dropdown-title">{getAgentName(agentId)} 模型</span>
              <span className="chat-model-dropdown-meta">{availableModels.length} 个可用</span>
              <button
                type="button"
                className="chat-model-config-btn"
                title="配置模型"
                aria-label="配置模型"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenModelConfig();
                }}
              >
                <Settings size={13} />
              </button>
            </div>
            {availableModels.length === 0 && (
              <div className="chat-dropdown-empty">暂无可用模型</div>
            )}
            {modelProviders.map((provider) => {
              const providerModels = modelsByProvider.get(provider) || [];
              const isExpanded = expandedProvider === provider;
              const hasActiveModel = providerModels.some(
                (model) => model.id === currentModel?.id && model.provider === currentModel?.provider
              );
              return (
                <div key={provider} className={`chat-dropdown-provider-group ${isExpanded ? "expanded" : ""}`}>
                  <div
                    className={`chat-dropdown-provider ${isExpanded ? "expanded" : ""} ${hasActiveModel ? "has-active" : ""}`}
                    onClick={() => onExpandedProviderChange(isExpanded ? null : provider)}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <span className="chat-dropdown-provider-name">{provider}</span>
                    <span className="chat-dropdown-provider-count">{providerModels.length}</span>
                  </div>
                  {isExpanded && providerModels.map((model) => {
                    const isFav = isFavoriteModel(model);
                    const isActive = currentModel?.id === model.id && currentModel?.provider === model.provider;
                    return (
                      <div
                        key={model.id}
                        className={`chat-dropdown-item ${isActive ? "active" : ""}`}
                        onClick={() => onSelectModel(model)}
                      >
                        <span className="chat-dropdown-model-main">
                          <span className="truncate">{model.name}</span>
                          {isActive && <span className="chat-dropdown-current-badge">当前</span>}
                        </span>
                        <button
                          onClick={(event) => { event.stopPropagation(); onToggleFavorite(model); }}
                          className={`chat-dropdown-star ${isFav ? "fav" : ""}`}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill={isFav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div ref={thinkingRef} className="relative">
        <button
          onClick={() => {
            onThinkingOpenChange(!thinkingOpen);
            onModelOpenChange(false);
          }}
          className="chat-toolbar-select"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
            <path d="M10 21h4" />
          </svg>
          <span>思考: {currentThinking.label}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {thinkingOpen && (
          <div className="chat-thinking-dropdown">
            {thinkingLevels.map((level) => (
              <button
                key={level.id}
                onClick={() => onSelectThinking(level.id)}
                className={`chat-thinking-option ${thinkingLevel === level.id ? "active" : ""}`}
              >
                {level.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
