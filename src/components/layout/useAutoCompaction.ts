import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectStore, type AgentStatus } from "@/stores/project-store";
import { useChatStore, type SessionContextUsage } from "@/stores/chat-store";
import { loadContextCompactionThreshold } from "@/lib/context-compaction-threshold";
import {
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  isContextThresholdReached,
} from "@shared/context-compaction-threshold";
import { GENERAL_SETTINGS_UPDATED_EVENT } from "@/lib/app-events";
import { showFloatingToastMessage } from "@/lib/floating-toast";

/**
 * 智能压缩：上下文用量到达用户设定的阈值（百分比）时，自动压缩一次。
 *
 * 为什么不在 token_usage 事件里直接触发：所有后端的 compact() 都要求 agent idle，
 * 回合中调用只会失败。这里把「监测」和「执行」分开——到达阈值先挂起（armed），
 * 等该会话变 idle 再执行。
 *
 * 防重复：压缩后用量未必立刻落到阈值以下，用 above 闩锁保证「回到阈值以下之前只压一次」，
 * 等用量重新回落后再涨上来，才会再次触发。
 */

type WatchState = {
  /** 用量已在阈值之上（压缩后仍在上方也不重复触发，直到回落到阈值以下）。 */
  above: boolean;
  /** 已到达阈值，等回合结束执行压缩。 */
  armed: boolean;
};

export function useAutoCompaction(activeSessionId: string | null | undefined, enabled = true) {
  const agentStatus = useProjectStore((state) =>
    activeSessionId ? state.agentStatuses[activeSessionId] : undefined,
  );
  const usage = useChatStore((state) =>
    activeSessionId ? state.contextUsageBySession[activeSessionId] : undefined,
  );
  const compacting = useChatStore((state) =>
    activeSessionId ? state.compactingSessions[activeSessionId] : undefined,
  );

  const [threshold, setThreshold] = useState(DEFAULT_CONTEXT_COMPACTION_THRESHOLD);
  const [thresholdReady, setThresholdReady] = useState(false);
  const watchRef = useRef<WatchState>({ above: false, armed: false });
  const sessionRef = useRef<string | null | undefined>(activeSessionId);

  const reloadThreshold = useCallback(() => {
    void loadContextCompactionThreshold().then((percent) => {
      setThreshold(percent);
      setThresholdReady(true);
    });
  }, []);

  useEffect(() => {
    reloadThreshold();
  }, [reloadThreshold]);

  // 用户在上下文弹窗里拖动阈值后立即生效，不必重开会话。
  useEffect(() => {
    const onGeneralSettingsUpdated = () => reloadThreshold();
    window.addEventListener(GENERAL_SETTINGS_UPDATED_EVENT, onGeneralSettingsUpdated);
    return () => window.removeEventListener(GENERAL_SETTINGS_UPDATED_EVENT, onGeneralSettingsUpdated);
  }, [reloadThreshold]);

  // 会话切换时重置闩锁，避免把 A 会话的 armed 带到 B。
  useEffect(() => {
    if (sessionRef.current !== activeSessionId) {
      sessionRef.current = activeSessionId;
      watchRef.current = { above: false, armed: false };
    }
  }, [activeSessionId]);

  const evaluate = useCallback((
    nextUsage: SessionContextUsage | undefined,
    status: AgentStatus | undefined,
    thresholdPercent: number,
  ) => {
    if (!enabled || !activeSessionId) return;
    // 压缩完成会清空 usage：此时保持闩锁不动（用量未知不代表已回落），
    // 等下一条真实用量读数再判断。
    if (!nextUsage || !status) return;

    const windowSize = Number(nextUsage.contextWindow);
    const used = Number(nextUsage.usedTokens);
    if (!Number.isFinite(windowSize) || windowSize <= 0 || !Number.isFinite(used) || used <= 0) return;
    // 跟手动压缩一致：模型变更后用量暂时不可信，不据此触发。
    if (nextUsage.model && !nextUsage.usageRatio) return;

    const ratio = used / windowSize;
    const state = watchRef.current;
    if (!isContextThresholdReached(ratio, thresholdPercent)) {
      // 回落到阈值以下：解除闩锁，下次再涨上来可以重新触发。
      state.above = false;
      state.armed = false;
    } else if (!state.above) {
      state.above = true;
      state.armed = true;
    }

    // 只在回合空闲、没有正在压缩、且已到达阈值时执行。
    if (status !== "idle" || compacting || !state.armed) return;
    state.armed = false;
    void window.electronAPI.agentCompactSession(activeSessionId).then((result) => {
      if (!result?.success) {
        // 失败不反复重试：把挂起重置，等下一次用量/状态事件再判断（用量若已回落则自然解锁）。
        watchRef.current.armed = true;
        showFloatingToastMessage(result?.error || `自动压缩失败（阈值 ${thresholdPercent}%）`);
      }
    }).catch(() => {
      watchRef.current.armed = true;
    });
  }, [activeSessionId, compacting, enabled]);

  useEffect(() => {
    if (!thresholdReady) return;
    // threshold 参与依赖：用户拖动阈值后要用当前用量立刻重新评估一次。
    evaluate(usage, agentStatus, threshold);
  }, [usage, agentStatus, threshold, evaluate, thresholdReady]);
}
