import { useState, useRef, useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useProjectStore } from "@/stores/project-store";
import { Brain, ChevronDown } from "lucide-react";

const LEVELS = [
  { id: "off", label: "关闭" },
  { id: "minimal", label: "最低" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "极高" },
];

export function ThinkingLevel() {
  const { thinkingLevel, setThinkingLevel } = useChatStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = LEVELS.find((l) => l.id === thinkingLevel) || LEVELS[3];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = async (levelId: string) => {
    setThinkingLevel(levelId);
    setOpen(false);
    const sessionId = useProjectStore.getState().activeSessionId;
    await window.electronAPI.agentSetThinkingLevel(levelId, sessionId || undefined);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 hover:border-zinc-600 transition-colors"
      >
        <Brain size={12} />
        <span>思考: {current.label}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-32 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50">
          {LEVELS.map((level) => (
            <button
              key={level.id}
              onClick={() => handleSelect(level.id)}
              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                thinkingLevel === level.id
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-zinc-300 hover:bg-zinc-700/50"
              }`}
            >
              {level.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
