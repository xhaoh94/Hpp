/**
 * 主进程侧的智能压缩触发器。
 *
 * 各家 Agent（pi / claude / codex / opencode）的自动压缩触发点各不相同，
 * 有的能改配置（pi 的 reserveTokens、codex 的 token limit），有的只能重启生效。
 * 这里反过来做：Hpp 自己看用量，到阈值就在回合结束（backend idle）时调一次
 * 各后端已有的 `compact()`，于是四家共用同一套触发逻辑，也不用改任何 CLI 配置。
 *
 * 触发必须同时满足三条：
 * 1. 用量读数到达阈值；
 * 2. 正好是回合结束（backend_idle / agent_end / aborted），且后端确实 idle；
 * 3. 这一回合是在「阈值最后一次调整之后」才开始跑的。
 *
 * 第 3 条是刻意的：拖动阈值本身绝不能触发压缩（历史 bug）。只比较用量大小不够——
 * 用户拖完阈值后同一回合的读数常常还会略涨（最后一次 token_usage 比界面显示的旧读数新），
 * 那样照样会被压掉。只有「新回合」才是真正的下一次对话。
 *
 * 压缩结束也用同一条规则重新上锁（armedEpoch = turnEpoch）：压缩本身会产生流式
 * 事件、把回合序号推进一格，而摘要请求的用量又常在压缩结束后才掉队到达。不重新
 * 上锁的话，闩锁会被那条「压缩前的历史长度」重新点亮，紧接着的 idle 立刻再压一次。
 *
 * 触发点的兜底仍留在各家 CLI：本控制器只管「提前压」。
 * 默认 100% = 不干预（没配过的模型不自动压缩），需要提前压的由用户按模型显式调低。
 *
 * 两个时序细节：
 * - 终端事件（尤其手动中断的 aborted）是同步发出的，宿主的 isIdle() 缓存
 *   要等一次异步探测才翻成 true，而且中断之后不会再有 backend_idle。
 *   所以「读数过关但后端还没空闲」时会做有限次数的重试（见 scheduleIdleRetry）。
 * - 比例要「用量 / 窗口」两个数。窗口可能只有渲染层知道（模型目录），
 *   由 setSessionContextWindow() 兜底；后端上报的窗口优先。
 *
 * 阈值按会话生效：agent-manager 解析出「渠道 + 模型」对应的百分比后
 * 通过 setSessionThreshold() 下发，控制器只保存「会话 → 百分比」。
 * 没有会话级配置时退回缺省阈值（旧版全局设置）。
 */
import { isAgentTurnContinuationEvidence } from "../../shared/agent-event-lifecycle";
import {
  DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  isContextThresholdReached,
  normalizeContextCompactionThreshold,
} from "../../shared/context-compaction-threshold";

export interface ContextCompactionBackend {
  isIdle(): boolean;
  /** 手动压缩；未实现的后端不参与自动压缩。 */
  compact?(): Promise<void>;
}

export interface ContextCompactionHost {
  getBackend(sessionId: string): ContextCompactionBackend | undefined;
  /** 压缩失败时上报（写日志 / 通知界面），不阻断后续判定。 */
  onError?(sessionId: string, message: string): void;
}

interface SessionCompactionState {
  usedTokens?: number;
  contextWindow?: number;
  /** 等后端真正空闲的重试计时器（终端事件早于空闲探测落地时用）。 */
  idleRetryTimer?: ReturnType<typeof setTimeout>;
  idleRetryAttempt: number;
  /** 用量已在阈值之上，并且还没回落到阈值以下（防止压缩无效时每回合反复压）。 */
  above: boolean;
  /** 允许在下一个回合结束时触发。 */
  armed: boolean;
  /** 当前回合是否还在跑。 */
  turnActive: boolean;
  /** 回合序号：每观察到一次「空闲 → 活动」就 +1。 */
  turnEpoch: number;
  /** 允许触发的最小回合序号；调整阈值时抬到当前序号，于是只能等下一个回合。 */
  armedEpoch: number;
  /** 正在压缩，避免重入。 */
  compacting: boolean;
  /** 压缩尝试序号：看门狗解除锁后，旧 compact() 的 finally 不能清掉新尝试。 */
  compactionAttempt: number;
  /** 后端正在压缩（原生或手动）：期间上报的用量不是「当前上下文」，不能拿来判定。 */
  compactionActive: boolean;
  /** 压缩看门狗：后端既不回终态、compact() 也不拒绝时兜底解除压制。 */
  compactionWatchdog?: ReturnType<typeof setTimeout>;
  /** 最近一次压缩终态的时间：用来识别「终态事件 + compact() 抛错」是同一次失败。 */
  lastCompactionEndAt: number;
  /** 最近一次已上报的失败原因：同样的原因连续出现时不重复刷屏。 */
  lastFailureMessage?: string;
}

const createState = (): SessionCompactionState => ({
  above: false,
  armed: false,
  turnActive: false,
  turnEpoch: 0,
  armedEpoch: 0,
  compacting: false,
  compactionAttempt: 0,
  compactionActive: false,
  lastCompactionEndAt: 0,
  idleRetryAttempt: 0,
});

/**
 * 终端事件（aborted / stream_end）是同步发出来的，宿主那份 `isIdle()` 缓存
 * 还要等一次异步探测才会翻成 true。轮询间隔取一个「探测通常已经回来」的量级。
 */
const IDLE_RETRY_INTERVAL_MS = 150;
/** 最多等 6s：再久就不是「晚一拍」，而是后端真的还在干活，交给下一个回合结束。 */
const IDLE_RETRY_MAX_ATTEMPTS = 40;
/**
 * 压缩看门狗：四家的 compact() 超时都在 180s 以内（worker 兜底更早）。
 * 超过这个时间还没收到终态，说明事件丢了或进程卡死——必须解除「压缩中」的
 * 用量压制，否则这个会话的阈值会永久静默失效，直到换模型或重开会话。
 */
const COMPACTION_WATCHDOG_MS = 240_000;
/**
 * 终态事件之后这么短时间内的 compact() 拒绝，视为同一次失败。
 * 后端都是先发 `context_compaction failed` 再让命令失败，界面已经有记录了；
 * 不压制的话每次失败都会冒出两条「压缩失败」。
 */
const COMPACTION_FAILURE_DEDUPE_MS = 10_000;

export class ContextCompactionController {
  /** 没有会话级配置时的缺省阈值（兼容旧版全局设置）。 */
  private threshold: number;
  /** 会话级阈值：由上层按「渠道 + 模型」解析后下发，切换模型时会重设。 */
  private sessionThresholds = new Map<string, number>();
  private states = new Map<string, SessionCompactionState>();

  constructor(
    private readonly host: ContextCompactionHost,
    threshold: unknown = DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  ) {
    this.threshold = normalizeContextCompactionThreshold(threshold);
  }

  /** 不传 sessionId 时返回缺省阈值。 */
  getThreshold(sessionId?: string): number {
    if (sessionId) {
      const scoped = this.sessionThresholds.get(sessionId);
      if (typeof scoped === "number") return scoped;
    }
    return this.threshold;
  }

  /**
   * 更新缺省阈值（没有会话级配置时生效）。只改变后续判定的基准，不立即评估——
   * 用户把阈值拖到当前用量以下时，不应该当场压缩，也不算「本回合就该压」。
   */
  setThreshold(value: unknown): void {
    const next = normalizeContextCompactionThreshold(value);
    if (next === this.threshold) return;
    this.threshold = next;
    for (const [sessionId, state] of this.states.entries()) {
      // 有自己的模型阈值（渠道 + 模型）时不受缺省值影响。
      if (this.sessionThresholds.has(sessionId)) continue;
      // 已经开跑的回合不算：抬到当前序号，等下一个回合结束再判定。
      state.armedEpoch = state.turnEpoch;
      state.above = false;
      state.armed = false;
    }
  }

  /**
   * 设置某个会话的阈值（上层按会话当前模型解析出的值）。
   * 与拖动阈值同样处理：只影响后续回合，不立即评估。
   */
  setSessionThreshold(sessionId: string, value: unknown): void {
    if (!sessionId) return;
    const next = normalizeContextCompactionThreshold(value);
    if (this.sessionThresholds.get(sessionId) === next) return;
    this.sessionThresholds.set(sessionId, next);
    const state = this.states.get(sessionId);
    if (!state) return;
    state.armedEpoch = state.turnEpoch;
    state.above = false;
    state.armed = false;
  }

  /**
   * 记录渲染层已知的上下文窗口（模型目录里的那份）。
   *
   * 后端上报的用量事件不一定带窗口（老版本 OpenCode、部分第三方插件），
   * 没有窗口就算不出比例，阈值会静默失效。这里只补「窗口」这一项：
   * 不评估、不触发 —— 触发点仍然只认回合边界或新读数，所以换会话、
   * 打开历史记录都不会因为同步窗口而突然压一次。
   * 后端自己上报的窗口优先（`handleUsage` 会覆盖这里写入的值）。
   */
  setSessionContextWindow(sessionId: string, value: unknown): void {
    if (!sessionId) return;
    const contextWindow = Number(value);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
    const state = this.getState(sessionId);
    if (state.contextWindow === contextWindow) return;
    state.contextWindow = contextWindow;
  }

  /**
   * 旁路接收后端事件。只关心三类：
   * - `token_usage`：刷新用量读数（永远不会单独触发压缩）；
   * - 回合活动证据：标记新回合开始，并推进回合序号；
   * - 回合结束信号：此时才允许真正调用 compact()。
   */
  observeEvent(sessionId: string, event: Record<string, unknown>): void {
    if (!sessionId) return;

    if (isAgentTurnContinuationEvidence(event)) {
      const state = this.getState(sessionId);
      if (!state.turnActive) {
        state.turnActive = true;
        state.turnEpoch += 1;
        // 新回合开始：上一回合的「等空闲」重试作废，等这一回合结束再判定。
        state.idleRetryAttempt = 0;
        this.clearIdleRetry(state);
      }
      return;
    }

    switch (event.type) {
      case "token_usage":
        // 压缩（摘要）请求自己的用量：它的输入是压缩前的整段历史，
        // 不是压缩后的上下文，拿它判定会立刻再压一次。等下一轮真实读数。
        // 除了后端自觉打的 `compaction` 标记，压缩窗口内一律不看读数：
        // 有的后端（pi / claude / codex）不会给摘要请求打标。
        if (event.compaction === true) break;
        if (this.getState(sessionId).compactionActive) break;
        this.handleUsage(sessionId, event);
        break;
      case "backend_idle":
      case "agent_end":
        this.getState(sessionId).turnActive = false;
        this.tryCompact(sessionId);
        break;
      case "aborted": {
        const state = this.getState(sessionId);
        state.turnActive = false;
        // 中断也可能发生在压缩过程中（用户按停止放弃这次压缩）：那就是明确的
        // 「别再压了」，不能因为压缩自己的流式事件推进了回合序号就立刻重来一次。
        if (state.compactionActive) {
          state.compactionActive = false;
          // compact() 可能永远不会 settle（后端卡死）：这里也要解除重入锁，
          // 否则 tryCompact 会一直因为 compacting=true 提前返回。
          state.compacting = false;
          state.compactionAttempt += 1;
          state.armedEpoch = state.turnEpoch;
          state.lastCompactionEndAt = Date.now();
          this.clearCompactionWatchdog(state);
        }
        this.tryCompact(sessionId);
        break;
      }
      case "context_compaction": {
        const phase = typeof event.phase === "string" ? event.phase : "";
        // 旧 SDK 的兜底事件只知道「发生了压缩」，不带 phase：不能当成结束，
        // 否则会在压缩还在跑时解除压制；等真实终态或看门狗兜底。
        if (!phase) break;
        const state = this.getState(sessionId);
        // 已经有一次压缩在跑（后端原生或手动）：本回合不再自动触发。
        state.armedEpoch = state.turnEpoch;
        state.compactionActive = phase === "started";
        if (phase === "started") {
          // 事件可能丢（worker 崩、流断开）：挂一个看门狗兜底解除压制。
          this.armCompactionWatchdog(sessionId, state);
          break;
        }
        this.clearCompactionWatchdog(state);
        // 压缩结束：压缩前的用量读数作废，等下一轮重新上报。
        state.usedTokens = 0;
        state.above = false;
        state.armed = false;
        // 压缩自己也会产生流式事件（claude 的 /compact 就是一条普通命令），
        // 把 turnEpoch 推进了一格。这里重新上锁，否则压缩结束后掉队的
        // 摘要用量会把闩锁点回来，紧接着的 backend_idle 会立刻再压一次。
        state.armedEpoch = state.turnEpoch;
        state.lastCompactionEndAt = Date.now();
        // 压缩真正成功一次才算「这个原因已经解决」；失败原因要留着去重。
        if (phase === "completed") state.lastFailureMessage = undefined;
        break;
      }
      case "model_changed":
        // 换模型：窗口变了，旧读数与旧窗口都不再可信，重新开始。
        this.forget(sessionId);
        break;
      case "agent_init":
        // 会话重建：用量与闩锁作废，但窗口来自模型目录（和后端实例无关），
        // 必须留着 —— 否则不上报窗口的后端在重建后会永久失去阈值判定。
        this.resetUsage(sessionId);
        break;
      default:
        break;
    }
  }

  /** 会话关闭后清掉状态，避免把闩锁带到下一个复用同 id 的会话。 */
  forget(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      this.clearIdleRetry(state);
      this.clearCompactionWatchdog(state);
    }
    this.states.delete(sessionId);
    this.sessionThresholds.delete(sessionId);
  }

  /** 会话重建：只丢用量与闩锁，保留阈值和渲染层同步过来的窗口。 */
  private resetUsage(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    const { contextWindow } = state;
    this.clearIdleRetry(state);
    this.clearCompactionWatchdog(state);
    this.states.delete(sessionId);
    if (typeof contextWindow === "number" && contextWindow > 0) {
      this.getState(sessionId).contextWindow = contextWindow;
    }
  }

  /** 运行时整体关闭（插件热更新 / 退出）：所有会话的闩锁与阈值一起作废。 */
  reset(): void {
    for (const state of this.states.values()) {
      this.clearIdleRetry(state);
      this.clearCompactionWatchdog(state);
    }
    this.states.clear();
    this.sessionThresholds.clear();
  }

  private getState(sessionId: string): SessionCompactionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = createState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  private handleUsage(sessionId: string, event: Record<string, unknown>): void {
    const contextTokens = Number(event.contextTokens);
    const inputTokens = Number(event.inputTokens);
    const usedTokens = Number.isFinite(contextTokens) && contextTokens > 0
      ? contextTokens
      : Number.isFinite(inputTokens) && inputTokens > 0
        ? inputTokens
        : 0;
    const contextWindow = Number(event.contextWindow);
    const hasWindow = Number.isFinite(contextWindow) && contextWindow > 0;

    const state = this.getState(sessionId);
    // 分母以模型目录（Hpp 统一目录）为准，后端上报值只在没有目录值时兜底：
    // 各后端的口径不同（codex 扣预留、claude 用有效上限），跟着事件走会让
    // 同一个模型在不同插件里得出不同的占用比例，阈值也就跟着飘。
    if (!state.contextWindow && hasWindow) state.contextWindow = contextWindow;

    // 压缩后用量可能被清成 0：这就是「回落到阈值以下」，必须解除闩锁，
    // 否则之后涨回来永远不会再触发。
    if (usedTokens <= 0) {
      state.usedTokens = 0;
      state.above = false;
      state.armed = false;
      return;
    }

    state.usedTokens = usedTokens;
    this.updateLatch(sessionId, state);
    // 读数经常在回合结束之后才到（claude 的精确窗口就是异步上报的）：
    // 那时已经没有新的回合结束事件了。这里补一次判定，否则要等用户再发一条
    // 消息才会压缩。
    if (state.armed && !state.turnActive) this.tryCompact(sessionId);
  }

  /** 按最新读数刷新「已到达阈值」的闩锁。 */
  private updateLatch(sessionId: string, state: SessionCompactionState): void {
    if (!this.isReached(sessionId, state)) {
      // 回落到阈值以下：解除闩锁，下次再涨上来可以重新触发。
      state.above = false;
      state.armed = false;
      return;
    }
    // 阈值刚调过 / 压缩刚结束：本回合的读数不算「到达」，必须等下一个新回合。
    // 只比用量大小不够——拖动阈值后同一回合的读数常常还会略涨。
    if (!state.above && state.turnEpoch <= state.armedEpoch) return;
    if (!state.above) {
      state.above = true;
      state.armed = true;
    }
  }

  private isReached(sessionId: string, state: SessionCompactionState): boolean {
    const threshold = this.getThreshold(sessionId);
    // 100% = 不按阈值提前压缩，把触发权交回各后端自己的极限兜底。
    if (threshold >= 100) return false;
    const { usedTokens, contextWindow } = state;
    if (!usedTokens || !contextWindow) return false;
    // 与弹窗共用同一份边界判定（含浮点容差），别在这里再抄一遍。
    return isContextThresholdReached(usedTokens / contextWindow, threshold);
  }

  private tryCompact(sessionId: string): void {
    const state = this.states.get(sessionId);
    // compactionActive：后端自己（或用户手动）正在压缩。此时再调 compact()
    // 只会拿到 SESSION_BUSY —— 闩锁可能在手动压缩开始前就已经点亮，
    // 光靠 armedEpoch 挡不住压缩自身的流式事件推进回合序号。
    if (!state || state.compacting || state.compactionActive) return;

    // 用最新读数重新确认一次：可能出现「挂起时到了阈值、回合结束时又被压缩过」。
    this.updateLatch(sessionId, state);
    if (!state.armed) return;
    // 阈值调整后还没跑过新回合：这次拖动不构成触发，等下一回合。
    if (state.turnEpoch <= state.armedEpoch) return;

    const backend = this.host.getBackend(sessionId);
    if (!backend?.compact) return;
    // 必须等回合真正结束：各后端的 compact() 在运行中会抛 SESSION_BUSY。
    if (!backend.isIdle()) {
      // 手动中断（aborted）就是这种时序：终止事件同步发出，宿主那边的空闲
      // 探测还在异步路上；而且中断之后不会再有 backend_idle 补一次，
      // 不重试就会永远错过这次压缩，直到用户再发一条消息。
      this.scheduleIdleRetry(sessionId, state);
      return;
    }

    this.clearIdleRetry(state);
    state.armed = false;
    // 同一回合只压一次（失败重试要等下一个回合）。
    state.armedEpoch = state.turnEpoch;
    state.compacting = true;
    const attempt = ++state.compactionAttempt;
    void backend.compact()
      .then(() => {
        // 压缩成功后用量未必立刻回落：保持 armed=false，
        // 等回落到阈值以下再涨上来才会再次触发。
      })
      .catch((error: unknown) => {
        // 失败允许下一个回合结束时再试，但不会在同一个回合里反复重试。
        state.armed = true;
        // 压缩没能确认结束（超时、后端卡死、事件流断开）：必须解除「正在压缩」的压制，
        // 否则这个会话的用量读数会被永久忽略，阈值从此静默失效，直到换模型或重开会话。
        // pi 的 compact() 超时只抛错、不会再补一条终态事件，最容易命中这条路径。
        state.compactionActive = false;
        this.clearCompactionWatchdog(state);
        const message = error instanceof Error ? error.message : String(error);
        // 只传原因：界面会自己加「上下文压缩失败：」前缀，这里再写一遍就重复了。
        this.reportFailure(sessionId, state, message);
      })
      .finally(() => {
        // 看门狗可能已经解除锁并开始下一次尝试：旧尝试的 finally 不能清掉新锁。
        if (state.compactionAttempt === attempt) state.compacting = false;
      });
  }

  /**
   * 终端事件比后端的空闲状态早到时，隔一小段时间再看一次。
   * 有次数上限：后端真的还在跑（比如中断尾部还有工具在收尾）就放弃，
   * 等它自己的回合结束事件。
   */
  private scheduleIdleRetry(sessionId: string, state: SessionCompactionState): void {
    if (state.idleRetryTimer) return;
    if (state.idleRetryAttempt >= IDLE_RETRY_MAX_ATTEMPTS) return;
    const timer = setTimeout(() => {
      state.idleRetryTimer = undefined;
      state.idleRetryAttempt += 1;
      // 会话被关掉 / 状态被换掉：这条计时器已经没有意义。
      if (this.states.get(sessionId) !== state) return;
      // 新回合已经在跑，或者已经被别的路径压过：停手，等下一次回合结束。
      if (state.turnActive || state.compacting || !state.armed) return;
      this.tryCompact(sessionId);
    }, IDLE_RETRY_INTERVAL_MS);
    // 一个待压缩的会话不该拖住进程退出。
    (timer as { unref?: () => void }).unref?.();
    state.idleRetryTimer = timer;
  }

  private clearIdleRetry(state: SessionCompactionState): void {
    if (!state.idleRetryTimer) return;
    clearTimeout(state.idleRetryTimer);
    state.idleRetryTimer = undefined;
  }

  /**
   * 压缩开始后挂一个看门狗。
   *
   * 正常路径上，压缩一定会以 `context_compaction` 终态或 `compact()` 抛错收尾，
   * 两条路都会解除 compactionActive。真正危险的是「两条都没来」：worker 崩在
   * 压缩中途、事件流断开、插件进程被杀。那时用量读数会被永久忽略，阈值从此
   * 静默失效——用户只会看到上下文一路涨到后端自己的极限。
   */
  private armCompactionWatchdog(sessionId: string, state: SessionCompactionState): void {
    this.clearCompactionWatchdog(state);
    const timer = setTimeout(() => {
      state.compactionWatchdog = undefined;
      // 会话被关掉 / 状态被换掉：这条计时器已经没有意义。
      if (this.states.get(sessionId) !== state) return;
      if (!state.compactionActive) return;
      state.compactionActive = false;
      // 后端的 compact() 可能还在等一个永远不结束的进程：看门狗必须同时
      // 清掉重入锁，否则这个会话的自动压缩会永久失效。
      state.compacting = false;
      state.compactionAttempt += 1;
      state.usedTokens = 0;
      state.above = false;
      state.armed = false;
      state.armedEpoch = state.turnEpoch;
      // 先上报再打时间戳：reportFailure 会看 lastCompactionEndAt 去重，
      // 顺序反过来会把自己这条提示也吞掉。
      this.reportFailure(sessionId, state, "压缩未在预期时间内结束（可能已中断）");
      state.lastCompactionEndAt = Date.now();
    }, COMPACTION_WATCHDOG_MS);
    // 一个待压缩的会话不该拖住进程退出。
    (timer as { unref?: () => void }).unref?.();
    state.compactionWatchdog = timer;
  }

  private clearCompactionWatchdog(state: SessionCompactionState): void {
    if (!state.compactionWatchdog) return;
    clearTimeout(state.compactionWatchdog);
    state.compactionWatchdog = undefined;
  }

  /**
   * 上报一次自动压缩失败，并做两层去重：
   * 1. 后端刚刚已经报过终态（它们都是先发事件再让命令失败）——界面有记录了；
   * 2. 与上次上报的原因完全相同——闩锁每回合都会重试，别把同一句话刷满对话。
   */
  private reportFailure(sessionId: string, state: SessionCompactionState, message: string): void {
    const now = Date.now();
    if (
      state.lastCompactionEndAt > 0
      && now - state.lastCompactionEndAt < COMPACTION_FAILURE_DEDUPE_MS
    ) {
      return;
    }
    if (state.lastFailureMessage === message) return;
    state.lastFailureMessage = message;
    this.host.onError?.(sessionId, message);
  }
}
