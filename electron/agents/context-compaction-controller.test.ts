import { describe, expect, it, vi } from "vitest";
import { ContextCompactionController } from "./context-compaction-controller";

const SESSION = "session-1";
const WINDOW = 1_000_000;

function usage(usedTokens: number, contextWindow = WINDOW) {
  return { type: "token_usage", contextTokens: usedTokens, contextWindow };
}

/** 回合开始：任何「正在干活」的证据都会推进回合序号。 */
const startTurn = { type: "agent_start" };
/** 回合结束：只有这个时候才可能真正调用 compact()。 */
const endTurn = { type: "backend_idle" };

function createHarness(options?: {
  threshold?: number;
  idle?: boolean;
  compact?: () => Promise<void>;
}) {
  let idle = options?.idle ?? true;
  const compact = vi.fn(options?.compact ?? (async () => {}));
  const errors: string[] = [];
  const controller = new ContextCompactionController({
    getBackend: () => ({ isIdle: () => idle, compact }),
    onError: (_sessionId, message) => errors.push(message),
  }, options?.threshold ?? 80);
  return {
    controller,
    compact,
    errors,
    setIdle: (value: boolean) => { idle = value; },
  };
}

/** compact 是 fire-and-forget，等一轮微任务让它落定。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ContextCompactionController", () => {
  it("compacts at the end of a turn once the usage reaches the threshold", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("无 phase 的压缩兜底事件不会提前解除压制", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, { type: "context_compaction", phase: "started" });
    // 旧 SDK 的兜底事件：只知道发生了压缩，不带 phase。
    controller.observeEvent(SESSION, { type: "context_compaction", id: "c1" });

    // 压缩仍在跑（真实终态没来）：后续读数和回合结束不能被当成「已经压完」。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("never compacts on a usage reading alone", async () => {
    // 恢复会话时用量是旧的（比如 85%），但没有任何回合结束：不能压。
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, usage(850_000));
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact below the threshold", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(500_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("waits for the turn to finish before compacting", async () => {
    const { controller, compact, setIdle } = createHarness({ idle: false });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    await flush();
    expect(compact).not.toHaveBeenCalled();

    setIdle(true);
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("compacts after a manual interrupt once the backend really settles", async () => {
    // aborted 是同步发出来的：那时候宿主那份 isIdle() 缓存还是 false，
    // 而且中断之后不会再有 backend_idle 来补一次。控制器必须自己回头看。
    vi.useFakeTimers();
    try {
      const { controller, compact, setIdle } = createHarness({ idle: false });
      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, usage(850_000));
      controller.observeEvent(SESSION, { type: "aborted" });
      expect(compact).not.toHaveBeenCalled();

      setIdle(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up waiting for idle once a new turn starts", async () => {
    vi.useFakeTimers();
    try {
      const { controller, compact, setIdle } = createHarness({ idle: false });
      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, usage(850_000));
      controller.observeEvent(SESSION, { type: "aborted" });
      // 用户中断后马上又发了一条：上一回合的等待作废，压缩要等这一回合结束。
      controller.observeEvent(SESSION, startTurn);
      setIdle(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(compact).not.toHaveBeenCalled();

      controller.observeEvent(SESSION, endTurn);
      await vi.advanceTimersByTimeAsync(0);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart a compaction the user just interrupted", async () => {
    // 阈值已到，但回合结束时后端还没空闲（这一步不压，留着闩锁）。
    const { controller, compact, setIdle } = createHarness({ idle: false });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    // 后端自己的原生压缩开始了，它的流式事件把回合序号推进了一格。
    controller.observeEvent(SESSION, { type: "context_compaction", phase: "started" });
    controller.observeEvent(SESSION, { type: "stream_delta", delta: "摘要中" });
    setIdle(true);
    // 用户按停止放弃这次压缩 —— 明确「别再压」，不能马上重来一次。
    controller.observeEvent(SESSION, { type: "aborted" });
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("uses the context window synced from the renderer when the backend omits it", async () => {
    const { controller, compact } = createHarness();
    // 模型目录里的窗口：后端上报的用量事件不带窗口时靠它算比例。
    controller.setSessionContextWindow(SESSION, WINDOW);
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, { type: "token_usage", contextTokens: 850_000 });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps the synced window when the session is rebuilt", async () => {
    const { controller, compact } = createHarness();
    controller.setSessionContextWindow(SESSION, WINDOW);
    // 会话重建（agent_init）：用量与闩锁作废，但窗口来自模型目录，不能跟着丢。
    controller.observeEvent(SESSION, { type: "agent_init" });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, { type: "token_usage", contextTokens: 850_000 });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps the catalog window when the backend reports a different one", async () => {
    const { controller, compact } = createHarness();
    // 目录窗口 1M，codex 照自己的口径只报 258k：分母不能被事件改小，
    // 否则同一个模型在 pi 里 26% 到 codex 里就变成 100%。
    controller.setSessionContextWindow(SESSION, 1_000_000);
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, { type: "token_usage", contextTokens: 300_000, contextWindow: 258_400 });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("never compacts just because a context window arrived", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    // 没有窗口时算不出比例，回合结束时也不该压。
    controller.observeEvent(SESSION, { type: "token_usage", contextTokens: 850_000 });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    // 窗口是元数据，不是回合边界：补上之后不能当场压。
    controller.setSessionContextWindow(SESSION, WINDOW);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not fire just because the threshold was dragged below current usage", async () => {
    const { controller, compact } = createHarness({ threshold: 80 });
    // 已经跑完一个回合，用量 13%。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(130_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    // 把阈值拖到 10%：拖动本身不能压。
    controller.setThreshold(10);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    // 拖完之后同一回合的迟到读数（比界面显示的略高）也不能压。
    controller.observeEvent(SESSION, usage(131_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    // 下一个回合结束才触发。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(140_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("ignores a threshold drag made in the middle of a running turn", async () => {
    const { controller, compact } = createHarness({ threshold: 80 });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(300_000));

    // 回合还在跑的时候把阈值拖到 10%：这个回合不算数。
    controller.setThreshold(10);
    controller.observeEvent(SESSION, usage(320_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    // 下一个回合才压。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(330_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way at 100%", async () => {
    const { controller, compact } = createHarness({ threshold: 100 });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(990_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not re-compact until the usage falls back below the threshold", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 压缩后用量未必立刻回落：下一回合仍然很高，不能再次压缩。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 回落后再涨上来，允许再压一次。
    controller.observeEvent(SESSION, usage(100_000));
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(860_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("allows a retry at the next turn end after a failed compaction", async () => {
    const compact = vi.fn()
      .mockRejectedValueOnce(new Error("SESSION_BUSY"))
      .mockResolvedValue(undefined);
    const { controller, errors } = createHarness({ compact });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain("SESSION_BUSY");

    // 同一回合里重复的 idle 事件不会反复重试。
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 下一个回合结束再试。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("re-arms after the usage is cleared to zero by a completed compaction", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 压缩完成：用量被清成 0（事件仍带窗口），闩锁必须解除。
    controller.observeEvent(SESSION, usage(0));
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(860_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("drops the stale window when the model changes", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    controller.observeEvent(SESSION, { type: "model_changed" });
    // 新模型的新读数：按新事件重新建立状态，不会被旧窗口残留影响。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(900_000, 200_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("skips auto compaction when another compaction is already running", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, { type: "context_compaction", phase: "started" });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("never arms on usage that came from the compaction request itself", async () => {
    const { controller, compact } = createHarness({ threshold: 10 });
    controller.observeEvent(SESSION, startTurn);
    // 摘要请求的输入是压缩前的整段历史，不能当成「当前上下文」来判定。
    controller.observeEvent(SESSION, { ...usage(190_000), compaction: true });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("drops the pre-compaction reading so a late summary usage cannot re-trigger", async () => {
    const { controller, compact } = createHarness({ threshold: 10 });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(190_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 压缩结束：压缩前的读数作废。
    controller.observeEvent(SESSION, { type: "context_compaction", phase: "completed" });
    // 摘要请求自己的用量（带 compaction 标记）随后到达，不能让挂起重置。
    controller.observeEvent(SESSION, { ...usage(190_000), compaction: true });
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 下一个回合的真实读数才重新判定。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(200_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("does not compact twice when the compaction itself advances the turn", async () => {
    // claude 的 /compact 就是一条普通命令：压缩过程会发 stream_delta（推进回合序号），
    // 结束时的 prompt_done 又带着「压缩前整段历史」的 usage。两者叠加不能让闩锁回弹。
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    controller.observeEvent(SESSION, { type: "context_compaction", phase: "started" });
    controller.observeEvent(SESSION, { type: "stream_delta", delta: "摘要中" });
    controller.observeEvent(SESSION, { type: "context_compaction", phase: "completed" });
    // 压缩结束后掉队到达的摘要用量（没打 compaction 标记，pi/claude/codex 都不打）。
    controller.observeEvent(SESSION, usage(860_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 真正的新回合才允许再压。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(870_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("ignores usage reported while a compaction is running", async () => {
    const { controller, compact } = createHarness({ threshold: 10 });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, { type: "context_compaction", phase: "started" });
    // 压缩窗口里的读数（没有 compaction 标记）不能点亮闩锁。
    controller.observeEvent(SESSION, usage(190_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("compacts when the usage reading only arrives after the turn ended", async () => {
    // claude 的精确窗口是回合结束后异步上报的：那次读数到达时已经没有
    // 新的回合结束事件，必须靠读数本身补一次判定。
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    controller.observeEvent(SESSION, usage(850_000));
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("forgets per-session state after the session closes", async () => {
    const { controller, compact } = createHarness();
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    controller.forget(SESSION);
    controller.observeEvent(SESSION, endTurn);
    await flush();
    // forget 后没有用量读数，不会仅凭 idle 触发。
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("uses the per-session threshold instead of the global default", async () => {
    const { controller, compact } = createHarness({ threshold: 80 });
    // 上层按「渠道 + 模型」解析出的值只作用于这个会话。
    controller.setSessionThreshold(SESSION, 40);
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(500_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps sessions on different models on their own thresholds", async () => {
    const sessions: string[] = [];
    const compact = vi.fn(async (sessionId: string) => {
      sessions.push(sessionId);
    });
    const controller = new ContextCompactionController({
      getBackend: (sessionId) => ({
        isIdle: () => true,
        compact: () => compact(sessionId),
      }),
    }, 80);

    controller.setSessionThreshold("cheap-model", 60);
    controller.setSessionThreshold("big-window-model", 95);

    for (const sessionId of ["cheap-model", "big-window-model"]) {
      controller.observeEvent(sessionId, startTurn);
      controller.observeEvent(sessionId, usage(700_000));
      controller.observeEvent(sessionId, endTurn);
    }
    await flush();
    // 60% 的那个压了，95% 的那个不压 —— 阈值不能互相串。
    expect(sessions).toEqual(["cheap-model"]);
  });

  it("does not fire when the per-session threshold is dragged down mid-conversation", async () => {
    const { controller, compact } = createHarness({ threshold: 80 });
    controller.setSessionThreshold(SESSION, 80);
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(130_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    controller.setSessionThreshold(SESSION, 10);
    controller.observeEvent(SESSION, usage(131_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(140_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("drops the model-scoped threshold when the model changes", () => {
    const { controller } = createHarness({ threshold: 80 });
    controller.setSessionThreshold(SESSION, 30);
    expect(controller.getThreshold(SESSION)).toBe(30);

    // 换模型后旧阈值不再适用；上层会按新模型重新下发。
    controller.observeEvent(SESSION, { type: "model_changed" });
    expect(controller.getThreshold(SESSION)).toBe(80);
  });

  it("stops ignoring usage after a compaction fails without a terminal event", async () => {
    // pi / codex 的 compact() 超时只抛错，不会再补一条「压缩结束」事件。
    // 如果控制器继续按 compactionActive 屏蔽读数，这个会话的阈值就永久失效了：
    // 用量怎么变都还是拿着压缩前的旧读数判定。
    let firstAttempt = true;
    const { controller, compact } = createHarness({
      compact: async () => {
        if (!firstAttempt) return;
        firstAttempt = false;
        // 后端已经开始压缩（这时候才会上报 started），然后卡住直到超时。
        controller.observeEvent(SESSION, { type: "context_compaction", id: "c1", phase: "started" });
        throw new Error("compact timed out");
      },
    });

    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);

    // 下一回合上下文已经降到 10%：新读数必须被接受，不能拿压缩前的 85% 再压一次。
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(100_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("does not call compact() while another compaction is still running", async () => {
    // 闩锁在手动压缩开始前就已经点亮：压缩自己的流式事件又会推进回合序号，
    // 光靠 armedEpoch 挡不住，必须显式看 compactionActive。
    const { controller, compact, setIdle } = createHarness({ idle: false });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();

    controller.observeEvent(SESSION, { type: "context_compaction", phase: "started" });
    controller.observeEvent(SESSION, { type: "stream_delta", delta: "摘要中" });
    setIdle(true);
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not repeat the failure notice when the backend already reported it", async () => {
    // 四家都是「先发 context_compaction failed，再让命令失败」：
    // 界面已经有失败分隔条了，主进程不该再补一条。
    const { controller, errors } = createHarness({
      compact: async () => {
        controller.observeEvent(SESSION, { type: "context_compaction", id: "c1", phase: "started" });
        controller.observeEvent(SESSION, {
          type: "context_compaction",
          id: "c1",
          phase: "failed",
          detail: "upstream 429",
        });
        throw new Error("upstream 429");
      },
    });
    controller.observeEvent(SESSION, startTurn);
    controller.observeEvent(SESSION, usage(850_000));
    controller.observeEvent(SESSION, endTurn);
    await flush();
    expect(errors).toEqual([]);
  });

  it("reports the same failure only once across turns", async () => {
    // 闩锁每回合都会重试：失败原因没变时不要把同一句话刷满对话。
    const { controller, errors } = createHarness({
      compact: async () => { throw new Error("SESSION_BUSY"); },
    });
    for (let index = 0; index < 3; index += 1) {
      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, usage(850_000));
      controller.observeEvent(SESSION, endTurn);
      await flush();
    }
    expect(errors).toHaveLength(1);
  });

  it("clears a stuck compaction once the watchdog fires", async () => {
    // worker 崩在压缩中途：既没有终态事件，compact() 也不会拒绝。
    // 看门狗必须解除用量压制，否则这个会话的阈值永久失效。
    vi.useFakeTimers();
    try {
      const { controller, compact, errors } = createHarness({ threshold: 10 });
      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, endTurn);
      controller.observeEvent(SESSION, { type: "context_compaction", id: "c1", phase: "started" });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(errors.join("\n")).toContain("未在预期时间内结束");

      // 下一回合的读数必须还能点亮闩锁。
      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, usage(190_000));
      controller.observeEvent(SESSION, endTurn);
      await vi.advanceTimersByTimeAsync(0);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a new compaction start after the watchdog releases a hung compact()", async () => {
    // compact() 永远不 settle 时，watchdog 只清 compactionActive 不够：
    // compacting 也必须解除，否则后续回合再也压不了。
    vi.useFakeTimers();
    try {
      const { controller, compact } = createHarness({
        threshold: 10,
        compact: () => new Promise<void>(() => undefined),
      });
      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, usage(200_000));
      controller.observeEvent(SESSION, endTurn);
      await vi.advanceTimersByTimeAsync(0);
      expect(compact).toHaveBeenCalledTimes(1);

      // 模拟后端已经进入压缩（真实场景由 context_compaction started 触发看门狗）。
      controller.observeEvent(SESSION, { type: "context_compaction", id: "hung", phase: "started" });
      await vi.advanceTimersByTimeAsync(300_000);

      controller.observeEvent(SESSION, startTurn);
      controller.observeEvent(SESSION, usage(200_000));
      controller.observeEvent(SESSION, endTurn);
      await vi.advanceTimersByTimeAsync(0);
      expect(compact).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
