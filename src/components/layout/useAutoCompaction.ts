import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectStore, type AgentStatus } from "@/stores/project-store";
import { useChatStore, type SessionContextUsage } from "@/stores/chat-store";
import { loadContextCompactionTiers } from "@/lib/context-compaction-tiers";
import { crossedCompactionTier } from "@shared/context-compaction-tiers";
import { showFloatingToastMessage } from "@/lib/floating-toast";

/**
 * 智能压缩：用户在上下文用量条上设的档位（百分比）被越过、且当前回合已结束（idle）时，
 * 自动触发一次压缩。压缩后用量回落，下次再涨到同一档可再次触发。
 *
 * 为什么不在 token_usage 事件里直接触发：所有后端的 compact() 都要求 agent idle，
 * 回合中调用只会失败。这里把「监测」和「执行」分开——用量越档先挂起（armed），
 * 等该会话变 idle 再执行。
 */

type ArmState = {
  /** 当前挂起等待 idle 时执行的最高档；没有挂起为 null。 */
  armedTier: number | null;
  /** 上次记录的用量比例，用于判断「从档位下方涨上来」。 */
  lastRatio: number;
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

  const tiersRef = useRef<number[]>([]);
  const armRef = useRef<ArmState>({ armedTier: null, lastRatio: 0 });
  const sessionRef = useRef<string | null | undefined>(activeSessionId);
  const [tiersReady, setTiersReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadContextCompactionTiers().then((tiers) => {
      if (alive) {
        tiersRef.current = tiers;
        setTiersReady(true);
      }
    });
    return () => { alive = false; };
  }, []);

  // 会话切换时重置闩锁，避免把 A 会话的 armed 带到 B。
  useEffect(() => {
    if (sessionRef.current !== activeSessionId) {
      sessionRef.current = activeSessionId;
      armRef.current = { armedTier: null, lastRatio: 0 };
    }
  }, [activeSessionId]);

  const maybeArm = useCallback((nextUsage: SessionContextUsage | undefined, status: AgentStatus | undefined) => {
    if (!enabled || !activeSessionId) return;
    // 压缩完成后 usage 被清空：把基线归零，下次从低位涨上来才能重新越过档位。
    // 注意保留已经 armed 的档位（那是等 idle 执行的）。
    if (!nextUsage || !status) {
      armRef.current.lastRatio = 0;
      return;
    }
    const windowSize = Number(nextUsage.contextWindow);
    const used = Number(nextUsage.usedTokens);
    if (!Number.isFinite(windowSize) || windowSize <= 0 || !Number.isFinite(used) || used <= 0) return;
    // 跟手动压缩一致：模型变更后用量暂时不可信，不据此触发。
    if (nextUsage.model && !nextUsage.usageRatio) return;

    const ratio = used / windowSize;
    const state = armRef.current;
    const crossed = crossedCompactionTier(ratio, state.lastRatio, tiersRef.current);
    if (crossed !== null && (state.armedTier === null || crossed > state.armedTier)) {
      state.armedTier = crossed;
    }
    state.lastRatio = ratio;

    // 只在回合空闲、没有正在压缩、且有挂起档位时执行。
    if (status !== "idle" || compacting || state.armedTier === null) return;
    const tier = state.armedTier;
    state.armedTier = null;
    void window.electronAPI.agentCompactSession(activeSessionId).then((result) => {
      if (!result?.success) {
        // 失败不反复重试：把档位重新挂起，等下次用量事件再判断（用量若已回落则自然解锁）。
        armRef.current.armedTier = tier;
        showFloatingToastMessage(result?.error || `自动压缩失败（${tier}%）`);
      }
    }).catch(() => {
      armRef.current.armedTier = tier;
    });
  }, [activeSessionId, compacting, enabled]);

  useEffect(() => {
    if (!tiersReady) return;
    maybeArm(usage, agentStatus);
  }, [usage, agentStatus, maybeArm, tiersReady]);
}
