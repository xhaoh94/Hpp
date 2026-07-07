import { useState, useRef, useEffect } from "react";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { ChevronDown, Star } from "lucide-react";

export function ModelSelector() {
  const {
    currentModel,
    setCurrentModel,
    availableModels,
    setAvailableModels,
    favoriteModels,
    toggleFavorite,
  } = useChatStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch models from agent on mount
  useEffect(() => {
    window.electronAPI.agentGetModels().then((models) => {
      if (models && models.length > 0) {
        setAvailableModels(models);
        const currentState = useChatStore.getState();
        const savedModel = currentState.currentModel;
        
        // Check if saved model is still available
        if (savedModel) {
          const modelMatch = models.find(
            (m) => m.id === savedModel.id && m.provider === savedModel.provider
          );
          if (modelMatch) {
            // Use saved model
            setCurrentModel(modelMatch);
          } else {
            // Saved model not available, use first model
            setCurrentModel(models[0]);
          }
        } else {
          // No saved model, use first model
          setCurrentModel(models[0]);
        }
      }
    });
  }, []);

  const models = availableModels;
  const providers = [...new Set(models.map((m) => m.provider))];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelectModel = async (model: ModelInfo) => {
    setCurrentModel(model);
    setOpen(false);
    const sessionId = useProjectStore.getState().activeSessionId;
    await window.electronAPI.agentSetModel(model.provider, model.id, sessionId || undefined);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 hover:border-zinc-600 transition-colors"
      >
        <span>{currentModel?.name || "选择模型"}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl overflow-hidden z-50 max-h-80 overflow-y-auto">
          {providers.length === 0 && (
            <div className="px-3 py-4 text-xs text-zinc-500 text-center">
              暂无可用模型
            </div>
          )}
          {providers.map((provider) => (
            <div key={provider}>
              <div className="px-3 py-1.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider bg-zinc-800 sticky top-0">
                {provider}
              </div>
              {models
                .filter((m) => m.provider === provider)
                .map((model) => {
                  const isFav = favoriteModels.some(
                    (f) => f.id === model.id && f.provider === model.provider
                  );
                  const isActive =
                    currentModel?.id === model.id &&
                    currentModel?.provider === model.provider;

                  return (
                    <div
                      key={model.id}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                        isActive
                          ? "bg-blue-600/20 text-blue-400"
                          : "hover:bg-zinc-700/50 text-zinc-300"
                      }`}
                    >
                      <button
                        className="flex-1 text-left text-xs truncate"
                        onClick={() => handleSelectModel(model)}
                      >
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{model.name}</span>
                        </span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(model);
                        }}
                        className={`p-0.5 transition-colors ${
                          isFav ? "text-yellow-400" : "text-zinc-600 hover:text-zinc-400"
                        }`}
                      >
                        <Star size={12} fill={isFav ? "currentColor" : "none"} />
                      </button>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
