import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Settings, Shield, ShieldAlert, ShieldCheck, WandSparkles } from "lucide-react";
import type { ModelInfo } from "@/stores/chat-store";
import { getAgentName } from "@/lib/agents";
import { getEffectiveThinkingLevelMode, getThinkingToggleLevel, groupModelsByProvider, includeCurrentModel, normalizeThinkingLevelId } from "@shared/models";
import type { AgentPermissionMode } from "@shared/agent-permissions";
import { useAnchoredOverlay } from "@shared/anchored-overlay";

type ThinkingLevelOption = {
  id: string;
  label: string;
};

type ChatToolbarProps = {
  activeAgentId: string;
  activeSessionAgentId?: string;
  availableModels: ModelInfo[];
  currentModel: ModelInfo | null;
  currentThinking?: ThinkingLevelOption;
  expandedProvider: string | null;
  favoriteModels: ModelInfo[];
  modelOpen: boolean;
  modelProviders: string[];
  /** 渠道 id → 渠道名；缺失时回退显示 id。 */
  providerNames: Record<string, string>;
  planModeEnabled: boolean;
  permissionMode: AgentPermissionMode;
  permissionModeSupported: boolean;
  permissionOpen: boolean;
  thinkingLevel: string;
  thinkingLevels: readonly ThinkingLevelOption[];
  thinkingOpen: boolean;
  modelRef: RefObject<HTMLDivElement | null>;
  thinkingRef: RefObject<HTMLDivElement | null>;
  permissionRef: RefObject<HTMLDivElement | null>;
  leadingContent?: ReactNode;
  getPlanModeTooltip: (agentId: string) => string;
  onExpandedProviderChange: (provider: string | null) => void;
  onModelOpenChange: (open: boolean) => void;
  onThinkingOpenChange: (open: boolean) => void;
  onPermissionOpenChange: (open: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
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
  providerNames,
  planModeEnabled,
  permissionMode,
  permissionModeSupported,
  permissionOpen,
  thinkingLevel,
  thinkingLevels,
  thinkingOpen,
  modelRef,
  thinkingRef,
  permissionRef,
  leadingContent,
  getPlanModeTooltip,
  onExpandedProviderChange,
  onModelOpenChange,
  onThinkingOpenChange,
  onPermissionOpenChange,
  onPlanModeChange,
  onPermissionModeChange,
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
  const selectableModels = useMemo(
    () => availableModels.length > 0 ? includeCurrentModel(availableModels, currentModel) : [],
    [availableModels, currentModel]
  );
  const modelsByProvider = useMemo(() => {
    return groupModelsByProvider(selectableModels);
  }, [selectableModels]);
  const isFavoriteModel = (model: ModelInfo) => favoriteModelKeys.has(`${model.provider}:${model.id}`);
  // 已展开分组里的模型按显示顺序拍平：键盘上下就是在这一串里移动。
  const flatModels = useMemo(
    () => modelProviders.flatMap((provider) =>
      expandedProvider === provider
        ? (modelsByProvider.get(provider) || []).map((model) => ({ provider, model }))
        : []
    ),
    [modelProviders, expandedProvider, modelsByProvider]
  );
  const modelIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    flatModels.forEach((entry, index) => map.set(`${entry.provider}:${entry.model.id}`, index));
    return map;
  }, [flatModels]);
  const [modelCursor, setModelCursor] = useState(0);
  /**
   * 只有键盘导航才把高亮行滚进可视区。
   *
   * 鼠标悬浮也会更新光标（好让方向键从鼠标位置接着走），但那不是"移动"，
   * 触发 scrollIntoView 会让列表在指针下自己跳一下。
   */
  const modelCursorScrollRef = useRef(false);
  const permissionMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const thinkingMenuRef = useRef<HTMLDivElement | null>(null);
  const permissionMenuStyle = useAnchoredOverlay(permissionOpen, permissionRef, permissionMenuRef);

  // 打开下拉时自动展开当前模型所在分组，并把光标停在这条上（键盘直接就能用）。
  useEffect(() => {
    if (!modelOpen) return;
    if (!expandedProvider && currentModel?.provider) {
      onExpandedProviderChange(currentModel.provider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen]);

  // 光标跟随当前模型 / 列表变化时收在合法范围内。
  useEffect(() => {
    if (!modelOpen) return;
    const currentIndex = flatModels.findIndex(
      (entry) => entry.model.id === currentModel?.id && entry.provider === currentModel?.provider
    );
    // 刚打开时把当前模型滚进可视区；之后只有键盘移动才滚。
    modelCursorScrollRef.current = true;
    setModelCursor(currentIndex >= 0 ? currentIndex : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen, flatModels.length]);
  const modelMenuStyle = useAnchoredOverlay(modelOpen, modelRef, modelMenuRef);
  const thinkingMenuStyle = useAnchoredOverlay(thinkingOpen, thinkingRef, thinkingMenuRef);

  // 键盘操作：上下移动高亮，Enter 应用，Esc 关闭。用捕获阶段是为了不被输入框抢走方向键。
  useEffect(() => {
    if (!modelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (flatModels.length === 0) {
          const firstProvider = modelProviders[0];
          if (firstProvider) onExpandedProviderChange(firstProvider);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        modelCursorScrollRef.current = true;
        setModelCursor((cursor) => (cursor + delta + flatModels.length) % flatModels.length);
        return;
      }
      if (event.key === "Enter") {
        const target = flatModels[modelCursor];
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        onSelectModel(target.model);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onModelOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [modelOpen, flatModels, modelProviders, modelCursor, onSelectModel, onModelOpenChange, onExpandedProviderChange]);

  // 高亮行滚进可视区：只在键盘移动/刚打开时做，悬浮不滚。
  //
  // 不用 scrollIntoView：它会把所有可滚动祖先一起带着滚，鼠标划过相邻行时
  // 外层对话区也跟着抖一下。这里只动下拉自己的 scrollTop。
  useEffect(() => {
    if (!modelOpen || !modelCursorScrollRef.current) return;
    modelCursorScrollRef.current = false;
    const container = modelMenuRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-model-index="${modelCursor}"]`);
    if (!container || !row) return;
    // 顶部是 sticky 标题栏，滚到顶的行会被它盖住，要把它算进可视区上边界。
    const header = container.querySelector<HTMLElement>(".chat-dropdown-header");
    const headerHeight = header?.offsetHeight ?? 0;
    const visibleTop = container.scrollTop + headerHeight;
    const visibleBottom = container.scrollTop + container.clientHeight;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < visibleTop) container.scrollTop = Math.max(0, rowTop - headerHeight);
    else if (rowBottom > visibleBottom) container.scrollTop = rowBottom - container.clientHeight;
  }, [modelOpen, modelCursor]);

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
        <WandSparkles size={14} />
        <span>计划</span>
      </button>

      {permissionModeSupported && <div ref={permissionRef} className="relative chat-permission-control">
        <button
          type="button"
          onClick={() => {
            onPermissionOpenChange(!permissionOpen);
            onModelOpenChange(false);
            onThinkingOpenChange(false);
          }}
          className={`chat-toolbar-select chat-permission-trigger ${permissionMode === "full-access" ? "danger" : ""}`}
          aria-haspopup="menu"
          aria-expanded={permissionOpen}
          title="设置权限"
        >
          {permissionMode === "full-access"
            ? <ShieldAlert size={14} />
            : permissionMode === "auto"
              ? <ShieldCheck size={14} />
              : <Shield size={14} />}
          <span>{permissionMode === "ask" ? "请求权限" : permissionMode === "auto" ? "自动权限" : "完全访问"}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {permissionOpen && createPortal(
          <div ref={permissionMenuRef} style={permissionMenuStyle} className="chat-permission-dropdown" data-chat-toolbar-overlay role="menu" aria-label="Agent 权限模式">
            <div className="chat-permission-heading">Agent 权限</div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={permissionMode === "ask"}
              className={`chat-permission-option ${permissionMode === "ask" ? "active" : ""}`}
              onClick={() => onPermissionModeChange("ask")}
            >
              <Shield size={16} />
              <span><strong>请求权限</strong><small>写文件、运行命令、联网等操作都先询问</small></span>
              {permissionMode === "ask" && <Check size={15} className="chat-permission-check" />}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={permissionMode === "auto"}
              className={`chat-permission-option ${permissionMode === "auto" ? "active" : ""}`}
              onClick={() => onPermissionModeChange("auto")}
            >
              <ShieldCheck size={16} />
              <span><strong>自动权限</strong><small>低风险操作自动执行，高风险操作先询问</small></span>
              {permissionMode === "auto" && <Check size={15} className="chat-permission-check" />}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={permissionMode === "full-access"}
              className={`chat-permission-option danger ${permissionMode === "full-access" ? "active" : ""}`}
              onClick={() => onPermissionModeChange("full-access")}
            >
              <ShieldAlert size={16} />
              <span><strong>完全访问权限</strong><small>不再询问，可访问系统并执行高风险操作</small></span>
              {permissionMode === "full-access" && <Check size={15} className="chat-permission-check" />}
            </button>
          </div>,
          document.body,
        )}
      </div>}

      <div ref={modelRef} className="relative">
        <button
          onClick={() => {
            onModelOpenChange(!modelOpen);
            onThinkingOpenChange(false);
            onPermissionOpenChange(false);
            if (modelOpen) onExpandedProviderChange(null);
          }}
          className="chat-toolbar-select"
        >
          {/* <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <circle cx="15.5" cy="8.5" r="1.5" />
            <path d="M8 14c0 0 1.5 2 4 2s4-2 4-2" />
          </svg> */}
          <span>{selectableModels.length > 0 ? (currentModel?.name || "选择模型") : "请先配置渠道"}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {modelOpen && createPortal(
          <div ref={modelMenuRef} style={modelMenuStyle} className="chat-dropdown chat-model-dropdown" data-chat-toolbar-overlay>
            <div className="chat-model-dropdown-header">
              <span className="chat-model-dropdown-title">{getAgentName(agentId)} 模型</span>
              <span className="chat-model-dropdown-meta">{selectableModels.length} 个可用</span>
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
            {selectableModels.length === 0 && (
              <div className="chat-dropdown-empty">暂无可用模型。</div>
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
                    <span className="chat-dropdown-provider-name">{providerNames[provider] || provider}</span>
                    <span className="chat-dropdown-provider-count">{providerModels.length}</span>
                  </div>
                  {isExpanded && providerModels.map((model) => {
                    const isFav = isFavoriteModel(model);
                    const isActive = currentModel?.id === model.id && currentModel?.provider === model.provider;
                    const flatIndex = modelIndexByKey.get(`${provider}:${model.id}`);
                    const isCursor = flatIndex !== undefined && flatIndex === modelCursor;
                    return (
                      <div
                        key={model.id}
                        data-model-index={flatIndex}
                        className={`chat-dropdown-item ${isActive ? "active" : ""} ${isCursor ? "keyboard-active" : ""}`}
                        onClick={() => onSelectModel(model)}
                        onMouseEnter={() => {
                          // 顺手清掉键盘留下的待滚动标记：单模型列表里方向键不会让
                          // 光标变化，标记会残留，下一次悬浮就会莫名滚一下。
                          modelCursorScrollRef.current = false;
                          if (flatIndex !== undefined) setModelCursor(flatIndex);
                        }}
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
          </div>,
          document.body,
        )}
      </div>

      {(() => {
        const effectiveMode = getEffectiveThinkingLevelMode(currentModel);
        if (!currentModel?.reasoning || !effectiveMode) return null;
        if (effectiveMode === "toggle") {
          const enabledLevel = getThinkingToggleLevel(currentModel);
          // 无档位声明时开=medium；自定义只选 1 档时开=该档；关始终为 off。
          return (
            <button
              onClick={() => onSelectThinking(normalizeThinkingLevelId(thinkingLevel) === "off" ? enabledLevel : "off")}
              className={`chat-toolbar-select chat-toolbar-thinking-toggle ${normalizeThinkingLevelId(thinkingLevel) !== "off" ? "active" : ""}`}
              title={normalizeThinkingLevelId(thinkingLevel) === "off" ? "开启思考" : "关闭思考"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                <path d="M10 21h4" />
              </svg>
              <span>{normalizeThinkingLevelId(thinkingLevel) === "off" ? "关" : "开"}</span>
            </button>
          );
        }
        if (!currentThinking || thinkingLevels.length === 0) return null;
        return (
        <div ref={thinkingRef} className="relative">
          <button
            onClick={() => {
              onThinkingOpenChange(!thinkingOpen);
              onModelOpenChange(false);
              onPermissionOpenChange(false);
            }}
            className="chat-toolbar-select"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
              <path d="M10 21h4" />
            </svg>
            <span>{currentThinking.label}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {thinkingOpen && createPortal(
            <div ref={thinkingMenuRef} style={thinkingMenuStyle} className="chat-thinking-dropdown" data-chat-toolbar-overlay>
              {thinkingLevels.map((level) => (
                <button
                  key={level.id}
                  onClick={() => onSelectThinking(level.id)}
                  className={`chat-thinking-option ${thinkingLevel === level.id ? "active" : ""}`}
                >
                  {level.label}
                </button>
              ))}
            </div>,
            document.body,
          )}
        </div>
        );
      })()}
    </div>
  );
}
