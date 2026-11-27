import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentImagePayload } from "../../../src/types/ipc";
import type { AgentActionCatalogEntry, AgentActionListOptions } from "../../../shared/agent-actions";
import type { AgentForkResult, AgentForkTarget } from "../../agents/agent-backend";
import type { AgentProcessStep } from "../../../src/stores/chat-store";
import { AgentEventBuffer } from "../../plugin-runtime/agent-event-buffer";
import { normalizeToolEvent } from "../../plugin-runtime/process-events";
import {
  CODEBUDDY_PACKAGE,
  buildCodebuddyInvocation,
  canPassComplexArgs,
  resolveCodebuddyCli,
  type ResolvedCodebuddyCli,
} from "./cli";
import {
  buildSkillPrompt,
  readCodebuddySkills,
  toCodebuddyActionCatalog,
  type CodebuddySkill,
} from "./skills";

/**
 * CodeBuddy / WorkBuddy CLI 后端。
 *
 * 调用方式是「一轮一进程」：`-p --output-format stream-json`，多轮靠 `--resume <session_id>`
 * 续会话。这样 abort 就是杀进程，不需要维护长连接的协议状态；代价是每轮多一次
 * CLI 冷启动（实测 ~1s）。
 */

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  supportsImages?: boolean;
  supportedThinkingLevels?: string[];
}

interface AgentSendOptions {
  planModeEnabled?: boolean;
  permissionMode?: string;
  displayMessage?: string;
  hostSystemPrompt?: string;
  clientMessageId?: string;
  action?: { kind: string; name: string };
}

interface AgentInitOptions {
  hostSystemPrompt?: string;
}

export interface CodebuddyBackendContext {
  getConfigState?: () => Promise<unknown>;
  dataDir?: string;
  pluginDir?: string;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
);
const optionalString = (value: unknown): string | undefined => (
  typeof value === "string" && value.trim() ? value : undefined
);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const CLI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const HPP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** 压缩超时：比手动 IPC 的 180s 略早，避免两边同时收尾。 */
const COMPACT_TIMEOUT_MS = 175_000;
/**
 * 这些变量代表「当前渠道的认证信息」。登录型渠道不能继承父进程里的同名变量，
 * 否则用户在系统环境里设过 token 时，所有账号都会被它覆盖。
 */
const PROVIDER_ENV_KEYS = [
  "CODEBUDDY_AUTH_TOKEN",
  "CODEBUDDY_API_KEY",
  "CODEBUDDY_BASE_URL",
  "CODEBUDDY_ACCOUNT_ID",
] as const;
const SAFE_ARG_TOKEN = /^[A-Za-z0-9._:-]+$/;
const FORK_DESCRIPTOR_PREFIX = "hpp-codebuddy-fork:v1:";
const UUID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 把 fork 信息编码进 sessionFilePath，随新会话带到 init。 */
function createForkDescriptor(sourceSessionId: string, newSessionId: string): string {
  const payload = Buffer.from(JSON.stringify({ sourceSessionId, newSessionId }), "utf8").toString("base64url");
  return `${FORK_DESCRIPTOR_PREFIX}${payload}`;
}

function parseForkDescriptor(value: string): { sourceSessionId: string; newSessionId: string } | null {
  if (!value.startsWith(FORK_DESCRIPTOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(FORK_DESCRIPTOR_PREFIX.length), "base64url").toString("utf8"));
    if (!parsed?.sourceSessionId || !parsed?.newSessionId) return null;
    return { sourceSessionId: parsed.sourceSessionId, newSessionId: parsed.newSessionId };
  } catch {
    return null;
  }
}

const mapPermissionMode = (mode: string | undefined): string => {
  switch (mode) {
    case "full-access":
      return "bypassPermissions";
    case "ask":
      return "default";
    case "auto":
    default:
      return "auto";
  }
};

/** hpp 档位 → CLI `--effort`。CLI 没有真正的关闭档：off 就是不传，交给模型默认。 */
const mapEffort = (level: string | undefined): string | null => {
  if (!level) return null;
  if (level === "off") return null;
  if (level === "ultra") return "max";
  return (CLI_EFFORTS as readonly string[]).includes(level) ? level : null;
};

const normalizeConfiguredModels = (value: unknown, provider: string): AgentModel[] => {
  return asArray(value).flatMap((rawModel) => {
    const model = asRecord(rawModel);
    const id = optionalString(model.id);
    if (!id) return [];
    const levels = Array.isArray(model.supportedThinkingLevels)
      ? model.supportedThinkingLevels.filter(
          (level): level is string => typeof level === "string" && level !== "off",
        )
      : undefined;
    return [{
      id,
      name: optionalString(model.name) || id,
      provider,
      reasoning: model.reasoning === true,
      contextWindow: Number.isFinite(Number(model.contextWindow)) && Number(model.contextWindow) > 0
        ? Number(model.contextWindow)
        : undefined,
      supportsImages: typeof model.imageInput === "boolean"
        ? model.imageInput
        : typeof model.supportsImages === "boolean" ? model.supportsImages : undefined,
      supportedThinkingLevels: levels && levels.length > 0 ? levels : undefined,
    }];
  });
};

const truncate = (value: string, max = 4_000): string => (
  value.length > max ? `${value.slice(0, max)}…` : value
);

/** stderr 是持续追加的，必须保留尾部；否则真正的报错会被前面的启动日志挤掉。 */
const truncateTail = (value: string, max = 4_000): string => (
  value.length > max ? `…${value.slice(-max)}` : value
);

/** 把 CLI 的 error/errors 字段转成可读文本，避免对象变成 [object Object]。 */
const describeError = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value === undefined || value === null ? "" : String(value);
};

/**
 * `--input-format stream-json` 的一行用户消息。
 * 图片用和 Claude Code 相同的 base64 content block；实测 CodeBuddy print 模式可直接识别。
 */
export const buildStreamJsonUserMessage = (
  text: string,
  images: ReadonlyArray<{ data: string; mimeType: string }>,
): string => {
  const content: UnknownRecord[] = [];
  if (text) content.push({ type: "text", text });
  for (const image of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    });
  }
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
};

const normalizeImagePayload = (images: unknown): Array<{ data: string; mimeType: string }> => (
  (Array.isArray(images) ? images : []).flatMap((rawImage) => {
    const image = asRecord(rawImage);
    const data = optionalString(image.data);
    const mimeType = optionalString(image.mimeType);
    return data && mimeType ? [{ data, mimeType }] : [];
  })
);

export class CodebuddyAgent {
  private proc: ChildProcess | null = null;
  private projectPath = "";
  private _sessionFilePath: string | null = null;
  /** fork 会话：源 session + 新 session id，CLI 用 --resume --fork-session 启动。 */
  private pendingFork: { sourceSessionId: string; newSessionId: string } | null = null;
  private eventBuffer: AgentEventBuffer;
  private models: AgentModel[] = [];
  /** 技能名 → 技能正文，供 listActions 与发送时复用。 */
  private skillCache = new Map<string, CodebuddySkill>();
  private providerId: string | null = null;
  private providerApiKey = "";
  private providerBaseUrl = "";
  private modelId = "auto";
  private thinkingLevel: string = "medium";
  private turnActive = false;
  private turnRevision = 0;
  private turnKind: "chat" | "compact" = "chat";
  private streamedText = false;
  private thinkingOpen = false;
  private thinkingStreamed = false;
  private usageReported = false;
  private contextReported = false;
  private resultSeen = false;
  /** 已写入 stdin、还没拿到对应 result 的引导条数。 */
  private pendingGuidance = 0;
  private guidanceTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Plan 模式下 TaskCreate/TaskUpdate 构建的步骤（CLI 自己规划，Hpp 负责展示）。 */
  private planSteps: AgentProcessStep[] = [];
  private taskToolIds = new Map<string, string>();
  /** 本轮是否在 Plan 模式（ExitPlanMode 后要主动收尾）。 */
  private planModeActive = false;
  private stderrTail = "";
  private compactId: string | null = null;
  private compactBoundarySeen = false;
  private compactError: string | null = null;
  private compactResolve: (() => void) | null = null;
  /** ask 模式在 headless 下无法交互授权：每个会话只提示一次，避免刷屏。 */
  private warnedPermissionAsk = false;
  private readonly toolNames = new Map<string, string>();
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();

  constructor(
    hppSessionId = "default",
    emit?: (event: UnknownRecord) => void,
    private readonly context?: CodebuddyBackendContext,
  ) {
    this.eventBuffer = new AgentEventBuffer(hppSessionId, emit);
  }

  /** 原生 session id（CLI 的 `session_id`），`--resume` 直接用。 */
  get sessionFilePath(): string | null {
    return this._sessionFilePath;
  }

  isIdle(): boolean {
    return !this.turnActive;
  }

  async init(projectPath: string, existingSessionFilePath?: string, options?: AgentInitOptions): Promise<void> {
    this.projectPath = projectPath || process.cwd();
    const rawSession = String(existingSessionFilePath || "").trim();
    this.pendingFork = parseForkDescriptor(rawSession);
    // fork 描述符不是真的 CLI session id：先记下源/新 id，等 CLI init 回报真实 id。
    this._sessionFilePath = this.pendingFork ? null : (rawSession || null);
    this.emit({ type: "agent_init", agentId: "codebuddy" });
    await this.loadProviderConfig(true);

    if (!this.resolveCli()) {
      this.emit({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "未找到 CodeBuddy CLI",
        detail: `请安装 ${CODEBUDDY_PACKAGE}（npm install -g），或在 WorkBuddy 桌面端登录后使用其内嵌 CLI；也可以用 CODEBUDDY_PATH 指定可执行文件。`,
        state: "error",
      });
    }
    if (String(options?.hostSystemPrompt || "").trim()) {
      // system prompt 每轮通过 --append-system-prompt 下发，这里只做提示。
    }
    this.emit({ type: "session_file_path", sessionFilePath: this._sessionFilePath });
    this.emit({ type: "agent_ready", agentId: "codebuddy", mock: false });
  }

  async sendMessage(message: string, images?: AgentImagePayload, options?: AgentSendOptions): Promise<void> {
    if (this.turnActive) throw new Error("SESSION_BUSY");
    const cli = this.resolveCli();
    if (!cli) throw new Error(`未找到 CodeBuddy CLI（${CODEBUDDY_PACKAGE}）。`);
    // 技能不存在要在这里失败：此时还没占用回合，不会把会话卡在 SESSION_BUSY。
    const skill = this.resolveSelectedSkill(options?.action);

    const revision = ++this.turnRevision;
    this.resetTurnState();
    this.planModeActive = !!options?.planModeEnabled;
    this.turnActive = true;
    // 渠道切换发生在会话重载时，而重载可能早于 activeProviderId 落盘；每轮
    // 重新读一次配置，保证账号 token / LOCALAPPDATA / baseUrl 跟着当前渠道走。
    await this.loadProviderConfig();
    if (revision !== this.turnRevision) return;

    this.emit({ type: "message_start", role: "user", content: options?.displayMessage || message });
    this.emit({ type: "stream_start", role: "assistant" });

    // headless 下 CLI 无法弹交互授权，ask 等价于“拒绝所有工具”。这里提前说清楚，
    // 避免用户以为按钮坏了；实际拒绝会由 CLI 的 tool_result 给出。
    if (options?.permissionMode === "ask" && !options.planModeEnabled && !this.warnedPermissionAsk) {
      this.warnedPermissionAsk = true;
      this.emit({
        type: "process_event",
        entryType: "info",
        kind: "info",
        title: "CodeBuddy 权限模式",
        detail: "CodeBuddy headless 模式无法弹出交互授权，当前“请求批准”会拒绝工具调用；需要执行工具请切换到“自动”或“完全访问”。",
        state: "completed",
      });
    }

    const validImages = normalizeImagePayload(images);
    if (Array.isArray(images) && images.length > 0 && validImages.length === 0) {
      this.emit({
        type: "process_event",
        entryType: "info",
        kind: "info",
        title: "图片未发送",
        detail: "图片数据不完整（缺少 data 或 mimeType），本条消息只发送了文字。",
        state: "completed",
      });
    }

    // 走 cmd 的 .cmd shim 没有可靠的参数转义：系统提示改走 stdin，
    // 不要作为命令参数交给 cmd。
    const complexArgs = canPassComplexArgs(cli);
    const messageText = skill ? buildSkillPrompt(skill, message) : message;
    const systemPrompt = String(options?.hostSystemPrompt || "").trim();
    const promptText = systemPrompt && !complexArgs ? `${systemPrompt}\n\n${messageText}` : messageText;
    const input = buildStreamJsonUserMessage(promptText, validImages);
    const started = this.spawnTurn(
      cli,
      this.buildArgs(options, validImages.length > 0, complexArgs),
      input,
      revision,
      true,
    );
    if (!started.ok) {
      this.failTurn(revision, started.error);
      throw new Error(started.error);
    }
  }

  /**
   * 手动压缩上下文。
   *
   * CLI 没有独立的 compact 接口，但 print 模式支持把 `/compact` 当一条命令从
   * stdin 读入（实测会返回 `system/compact_boundary`，带 `trigger/pre_tokens`）。
   * 所以这里复用一轮一进程：发 started → 等边界 → 发 completed，进程异常退出
   * 或没有边界时如实报 failed。整段压缩期间 `isIdle()` 保持 false，避免宿主
   * 提前把后端当成空闲。
   */
  async compact(): Promise<void> {
    if (this.turnActive) throw new Error("SESSION_BUSY");
    const cli = this.resolveCli();
    if (!cli) throw new Error(`未找到 CodeBuddy CLI（${CODEBUDDY_PACKAGE}）。`);
    if (!this._sessionFilePath) throw new Error("当前会话尚未建立，无法压缩上下文。");

    const revision = ++this.turnRevision;
    this.resetTurnState();
    this.turnActive = true;
    this.turnKind = "compact";
    this.compactId = `codebuddy-compact-${Date.now()}`;
    const settled = new Promise<void>((resolve) => { this.compactResolve = resolve; });
    this.emit({ type: "context_compaction", id: this.compactId, phase: "started" });
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (revision !== this.turnRevision) return;
      // CLI 可能卡在网络上：超时后必须杀进程，否则 turnActive 会永远为 true，
      // 后续发送全部 SESSION_BUSY，自动压缩也会被看门狗永久压制。
      this.killProcess();
      this.settleCompaction(revision, false, "CodeBuddy 压缩上下文超时。");
    }, COMPACT_TIMEOUT_MS);
    (timeout as { unref?: () => void }).unref?.();

    try {
      await this.loadProviderConfig();
      if (revision !== this.turnRevision) {
        // 刷新配置期间被取消：等待方已经被 abort 唤醒，这里只负责把错误透出去。
        await settled;
        const aborted = this.compactError;
        this.compactError = null;
        if (aborted) throw new Error(aborted);
        return;
      }

      const started = this.spawnTurn(cli, this.buildCompactArgs(), "/compact", revision);
      if (!started.ok) {
        this.settleCompaction(revision, false, started.error);
      }

      await settled;
      const error = this.compactError;
      this.compactError = null;
      if (error) throw new Error(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      timeout = null;
    }
  }

  /**
   * 原生 fork：CLI 的 --fork-session 按整个会话复制，不支持按消息回滚，
   * 所以新会话会带完整历史；Hpp 侧仍会显示从选中消息开始的可见历史。
   */
  async forkSession(target: AgentForkTarget): Promise<AgentForkResult> {
    const source = String(target.sourceSessionFilePath || this._sessionFilePath || "").trim();
    const newId = String(target.newSessionId || "").trim();
    if (!source || !newId) {
      return { supported: true, success: false, reason: "缺少源会话或新会话 ID" };
    }
    if (!UUID_TOKEN.test(source) || !UUID_TOKEN.test(newId)) {
      return { supported: true, success: false, reason: "会话 ID 含非法字符" };
    }
    return {
      supported: true,
      success: true,
      sessionFilePath: createForkDescriptor(source, newId),
      nativeEntryId: target.targetTurnId,
    };
  }

  async abort(): Promise<void> {
    const revision = this.turnRevision;
    this.killProcess();
    if (revision !== this.turnRevision) return;
    if (this.turnKind === "compact") {
      this.settleCompaction(revision, false, "上下文压缩已取消。", true);
      return;
    }
    this.turnRevision += 1;
    this.turnActive = false;
    this.proc = null;
    this.clearGuidanceTimeout();
    this.eventBuffer.clear();
    this.emit({ type: "aborted" });
  }

  async getModels(): Promise<AgentModel[]> {
    // 只返回渠道配置里的模型。没有渠道/没有模型时就是空列表 —— 不要用内置
    // 硬编码列表伪装成“已可用”，否则用户没登录也能看到一堆选不了的模型。
    return this.models.map((model) => ({ ...model }));
  }

  /**
   * 技能目录：项目级 / 用户级 SKILL.md + CLI 产品配置里下发的技能。
   * 没有任何技能时返回空列表，面板会显示空态。
   */
  async listActions(_options?: AgentActionListOptions): Promise<AgentActionCatalogEntry[]> {
    const skills = readCodebuddySkills(this.projectPath);
    this.skillCache = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
    return toCodebuddyActionCatalog(skills);
  }

  /** 把面板选中的技能解析成可注入的正文；找不到直接报错，不静默降级。 */
  private resolveSelectedSkill(action?: { kind?: string; name?: string }): CodebuddySkill | null {
    if (!action || action.kind !== "skill") return null;
    const name = String(action.name || "").trim().replace(/^\//, "");
    if (!name) return null;
    const cached = this.skillCache.get(name.toLowerCase());
    if (cached) return cached;
    // 面板可能还没拉过目录（例如快捷键直接发送）：重新读一次再判断。
    const skills = readCodebuddySkills(this.projectPath);
    this.skillCache = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
    const skill = this.skillCache.get(name.toLowerCase());
    if (!skill) throw new Error(`ACTION_NOT_FOUND: ${name}`);
    return skill;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (!modelId) throw new Error("模型 ID 为空。");
    this.modelId = modelId;
    if (provider) this.providerId = provider;
    this.emit({ type: "model_changed", model: { id: modelId, provider: provider || this.providerId || "codebuddy" } });
  }

  async setThinkingLevel(level: string): Promise<void> {
    const normalized = String(level || "").trim().toLowerCase();
    if (!(HPP_THINKING_LEVELS as readonly string[]).includes(normalized)) {
      throw new Error("UNSUPPORTED_THINKING_LEVEL");
    }
    this.thinkingLevel = normalized;
    this.emit({ type: "thinking_level_changed", level: normalized });
  }

  async sendUIResponse(): Promise<void> {
    // headless 模式不做权限/提问交互，权限由 --permission-mode 决定。
  }

  async dispose(): Promise<void> {
    this.eventBuffer.flush();
    this.killProcess();
    if (this.turnKind === "compact") {
      // 会话关闭时也要唤醒等待方，否则 compact() 会挂到看门狗超时。
      this.settleCompaction(this.turnRevision, false, "会话已关闭。", true);
      return;
    }
    this.turnActive = false;
    this.turnRevision += 1;
    this.clearGuidanceTimeout();
    const resolve = this.compactResolve;
    this.compactResolve = null;
    if (resolve) {
      this.compactError = "会话已关闭。";
      resolve();
    }
  }

  // ---------------------------------------------------------------- 内部

  private resetTurnState(): void {
    this.turnKind = "chat";
    this.streamedText = false;
    this.thinkingOpen = false;
    this.thinkingStreamed = false;
    this.usageReported = false;
    this.contextReported = false;
    this.resultSeen = false;
    this.pendingGuidance = 0;
    this.clearGuidanceTimeout();
    this.planSteps = [];
    this.taskToolIds.clear();
    this.planModeActive = false;
    this.stderrTail = "";
    this.toolNames.clear();
    this.startedTools.clear();
    this.finishedTools.clear();
    this.compactId = null;
    this.compactBoundarySeen = false;
    this.compactError = null;
  }

  private spawnTurn(
    cli: ResolvedCodebuddyCli,
    args: string[],
    prompt: string,
    revision: number,
    keepStdinOpen = false,
  ): { ok: true } | { ok: false; error: string } {
    const invocation = buildCodebuddyInvocation(cli, args);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    const providerEnv = this.buildProviderEnv();
    Object.assign(env, invocation.env, providerEnv, this.accountHomeEnv());
    // 登录型渠道不能继承父进程的 token：否则环境里设过一个 token，
    // 所有账号都会用它，切渠道/多账号隔离就失效了。
    for (const key of PROVIDER_ENV_KEYS) {
      if (!(key in providerEnv)) delete env[key];
    }

    let proc: ChildProcess;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: this.projectPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.proc = proc;

    const lines = createInterface({ input: proc.stdout! });
    lines.on("line", (line) => this.handleLine(line, revision));
    proc.stdout?.on("error", () => undefined);
    proc.stderr?.on("error", () => undefined);
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = truncateTail(`${this.stderrTail}${chunk.toString("utf8")}`, 8_000);
    });
    // CLI 在模型无效/认证失败时会立刻退出，而 stdin 还在写入（带图片时尤其大）。
    // 没有这个监听时，写入错误会成为未捕获异常，直接带走整个插件 worker。
    proc.stdin?.on("error", (error: Error) => {
      this.killProcess();
      this.failTurn(revision, `写入 CodeBuddy CLI 输入失败：${error.message}`);
    });
    proc.on("error", (error) => {
      this.failTurn(revision, error instanceof Error ? error.message : String(error));
    });
    proc.on("close", (code) => this.handleClose(revision, code));

    try {
      proc.stdin?.write(prompt);
      // stream-json 输入下 CLI 会在 result 后继续等输入：普通回合保持 stdin 打开，
      // 让 sendGuidance 能追加消息；/compact 用 text 输入，必须立即关闭。
      if (!keepStdinOpen) proc.stdin?.end();
    } catch {
      // stdin 关闭意味着进程已经退出，close 分支会收尾。
    }
    return { ok: true };
  }

  /** 完成一次手动压缩：收尾状态、上报终态并唤醒 compact() 的等待方。 */
  private settleCompaction(revision: number, ok: boolean, detail?: string, interrupted = false): void {
    if (revision !== this.turnRevision) return;
    this.turnRevision += 1;
    this.turnActive = false;
    this.turnKind = "chat";
    this.proc = null;
    const id = this.compactId;
    this.compactId = null;
    if (!ok) {
      this.compactError = detail || "CodeBuddy 压缩上下文失败";
      this.emit({
        type: "context_compaction",
        id: id || `codebuddy-compact-${Date.now()}`,
        phase: interrupted ? "interrupted" : "failed",
        ...(detail ? { detail } : {}),
      });
    }
    const resolve = this.compactResolve;
    this.compactResolve = null;
    resolve?.();
  }

  private resolveCli(): ResolvedCodebuddyCli | null {
    try {
      return resolveCodebuddyCli();
    } catch {
      return null;
    }
  }

  private async loadProviderConfig(initializing = false): Promise<void> {
    let state: UnknownRecord = {};
    try {
      state = asRecord(await this.context?.getConfigState?.());
    } catch {
      state = {};
    }
    const providers = asArray(state.providers).map(asRecord);
    const activeId = optionalString(state.activeProviderId);
    const previousProviderId = this.providerId;
    // active 还没落盘时优先保持当前渠道，其次才退回第一条；直接取第一条在多账号
    // 场景下可能把消息发到另一个账号。
    const active = providers.find((provider) => optionalString(provider.providerId) === activeId)
      ?? providers.find((provider) => optionalString(provider.providerId) === this.providerId)
      ?? providers[0];
    if (!active) {
      // 刷新失败时保留上一次的渠道凭据，避免把正在用的账号清空。
      if (initializing) this.models = [];
      return;
    }
    this.providerId = optionalString(active.providerId) || null;
    this.providerApiKey = String(active.apiKey || "").trim();
    this.providerBaseUrl = String(active.baseUrl || "").trim();
    const configured = normalizeConfiguredModels(active.models, this.providerId || "codebuddy");
    // 渠道里没有模型就是没有，不再用内置列表兜底。
    this.models = configured;
    const firstModelId = this.models[0]?.id;
    if (initializing) {
      if (firstModelId) this.modelId = firstModelId;
      return;
    }

    const providerChanged = !!previousProviderId && previousProviderId !== this.providerId;
    const modelMissing = !!firstModelId && !this.models.some((model) => model.id === this.modelId);
    if (modelMissing) this.modelId = firstModelId!;
    // 两个账号的模型列表通常完全一样：只比较模型 ID 会漏掉渠道切换，
    // 导致 Hpp 侧的 provider 和压缩阈值一直指向旧账号。压缩期间不发，
    // 避免 controller 在 started 之后把正在压缩的状态 forget 掉。
    if (this.turnKind !== "compact" && (providerChanged || modelMissing)) {
      this.emit({
        type: "model_changed",
        model: { id: this.modelId, provider: this.providerId || "codebuddy" },
      });
    }
  }

  /**
   * 登录渠道注入独立的 LOCALAPPDATA（里面是该账号的 CLI 登录态）；
   * token 渠道走 CODEBUDDY_AUTH_TOKEN，不碰登录目录。
   * 目录不存在（旧渠道/用户手填）时不注入，回退到系统默认账号。
   */
  private accountHomeEnv(): Record<string, string> {
    // Token 渠道用 CODEBUDDY_AUTH_TOKEN 认证；同时再注入 LOCALAPPDATA 会让 CLI
    // 可能优先读旧的登录文件，导致“填了 token 却用了另一个账号”。
    if (this.providerApiKey || process.platform !== "win32") return {};
    const dataDir = this.context?.dataDir;
    const providerId = this.providerId;
    if (!dataDir || !providerId) return {};
    const dir = join(dataDir, "codebuddy-accounts", providerId);
    if (!existsSync(join(dir, "CodeBuddyExtension", "Data", "Public", "auth"))) return {};
    return { LOCALAPPDATA: dir };
  }

  private buildProviderEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    // 只有渠道里真的存了 token（自定义网关/多账号）时才注入；否则表示用 CLI 自己的
    // 登录态。这两种情况都不能盲改 CODEBUDDY_BASE_URL：登录门户（如 www.codebuddy.cn）
    // 不是 API 端点，注进去会直接 405。
    if (this.providerApiKey) {
      env.CODEBUDDY_AUTH_TOKEN = this.providerApiKey;
      if (this.providerBaseUrl) env.CODEBUDDY_BASE_URL = this.providerBaseUrl;
    }
    return env;
  }

  private buildArgs(options: AgentSendOptions = {}, _hasImages = false, allowSystemPrompt = true): string[] {
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages"];
    // 统一走 stream-json 输入：运行中可以用 sendGuidance 往同一个进程追加消息。
    args.push("--input-format", "stream-json");
    const permission = options.planModeEnabled ? "plan" : mapPermissionMode(options.permissionMode);
    args.push("--permission-mode", permission);
    if (this.pendingFork) {
      // CLI 的 fork 是整会话复制（不支持按消息回滚），但能拿到独立 session id。
      args.push("--resume", this.pendingFork.sourceSessionId);
      args.push("--fork-session", "--session-id", this.pendingFork.newSessionId);
    } else if (this._sessionFilePath && SAFE_ARG_TOKEN.test(this._sessionFilePath)) {
      args.push("--resume", this._sessionFilePath);
    }
    if (this.modelId && this.modelId !== "auto" && SAFE_ARG_TOKEN.test(this.modelId)) {
      args.push("--model", this.modelId);
    }
    const effort = mapEffort(this.thinkingLevel);
    if (effort) args.push("--effort", effort);
    if (allowSystemPrompt) {
      const systemPrompt = String(options.hostSystemPrompt || "").trim();
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    }
    return args;
  }

  private buildCompactArgs(): string[] {
    // 压缩走本地命令，不需要 partial messages / system prompt / 权限参数。
    const args = ["-p", "--output-format", "stream-json"];
    if (this._sessionFilePath && SAFE_ARG_TOKEN.test(this._sessionFilePath)) {
      args.push("--resume", this._sessionFilePath);
    }
    if (this.modelId && this.modelId !== "auto" && SAFE_ARG_TOKEN.test(this.modelId)) {
      args.push("--model", this.modelId);
    }
    return args;
  }

  private handleLine(line: string, revision: number): void {
    if (revision !== this.turnRevision) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: UnknownRecord;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      return;
    }
    const type = optionalString(event.type);
    if (this.turnKind === "compact") {
      // `/compact` 只关心边界与最终结果，避免把命令输出误当成助手回复。
      if (type === "system") this.handleSystemEvent(event);
      else if (type === "result") this.handleResult(event, revision);
      return;
    }
    switch (type) {
      case "system":
        this.handleSystemEvent(event);
        break;
      case "stream_event":
        this.handleStreamEvent(event);
        break;
      case "assistant":
        this.handleAssistantMessage(event);
        break;
      case "user":
        this.handleUserMessage(event);
        break;
      case "result":
        this.handleResult(event, revision);
        break;
      default:
        break;
    }
  }

  private handleSystemEvent(event: UnknownRecord): void {
    const subtype = optionalString(event.subtype);
    if (subtype === "init") {
      const sessionId = optionalString(event.session_id);
      if (sessionId && sessionId !== this._sessionFilePath) {
        this._sessionFilePath = sessionId;
        // fork 首轮已经落地成独立 session，后续轮次直接 --resume 它。
        this.pendingFork = null;
        this.emit({ type: "session_file_path", sessionFilePath: sessionId });
      }
      const model = optionalString(event.model);
      if (this.turnKind !== "compact" && model && model !== this.modelId) {
        this.modelId = model;
        this.emit({ type: "model_changed", model: { id: model, provider: this.providerId || "codebuddy" } });
      }
      return;
    }
    if (subtype === "usage_update") {
      this.handleUsageUpdate(event);
      return;
    }
    if (subtype === "compact_boundary") {
      this.handleCompactBoundary(event);
      return;
    }
    if (subtype === "error") {
      this.emit({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "CodeBuddy 运行错误",
        detail: truncate(describeError(event.error) || describeError(event.message) || "未知错误"),
        state: "error",
      });
    }
  }

  /**
   * CLI 在每次请求结束时会发 `usage_update`，其中 `codebuddy.ai/contextUsed`
   * 是当前上下文占用，`usageByCategory` 是分类明细（比 host 侧估算精确）。
   * 用它上报纯上下文读数（input/output 为 0），避免和逐次响应用量重复累加。
   */
  private handleUsageUpdate(event: UnknownRecord): void {
    if (this.turnKind === "compact") return;
    const meta = asRecord(event["_meta"]);
    const used = Number(meta["codebuddy.ai/contextUsed"]);
    if (!Number.isFinite(used) || used <= 0) return;
    const category = asRecord(meta["codebuddy.ai/usageByCategory"]);
    const breakdown = [
      ["systemPrompt", "System prompt"],
      ["conversation", "对话"],
      ["tools", "工具定义"],
      ["mcp", "MCP"],
      ["skills", "技能"],
    ].flatMap(([key, label]) => {
      const tokens = Number(category[key]);
      return Number.isFinite(tokens) && tokens > 0
        ? [{ id: `codebuddy-context-${key}`, label, tokens }]
        : [];
    });
    const window = this.resolveContextWindow();
    this.contextReported = true;
    this.emit({
      type: "token_usage",
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: used,
      ...(window ? { contextWindow: window } : {}),
      ...(breakdown.length > 0 ? { contextBreakdown: breakdown } : {}),
      contextPrecision: "exact",
    });
  }

  /** `compact_boundary`：手动压缩发 completed 到原 id，自动压缩按 CLI 的 uuid 单独成条。 */
  private handleCompactBoundary(event: UnknownRecord): void {
    if (this.turnKind === "compact" && this.compactId) {
      if (this.compactBoundarySeen) return;
      this.compactBoundarySeen = true;
      this.emit({ type: "context_compaction", id: this.compactId, phase: "completed" });
      return;
    }
    const id = optionalString(event.uuid) || `codebuddy-compact-${Date.now()}`;
    this.emit({ type: "context_compaction", id, phase: "completed" });
  }

  private resolveContextWindow(): number | undefined {
    const model = this.models.find((item) => item.id === this.modelId);
    return model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined;
  }

  private handleStreamEvent(event: UnknownRecord): void {
    this.ensureMidTurnStreamStart();
    const sse = asRecord(event.event);
    const sseType = optionalString(sse.type);
    if (sseType === "message_start") {
      // 每条模型响应（不是每条 assistant 消息）开始时重置去重标记。
      // 同一响应可能先发 thinking 块、再发 text 块，两条 assistant 消息要共用标记。
      this.streamedText = false;
      this.thinkingStreamed = false;
      return;
    }
    if (sseType === "content_block_delta") {
      const delta = asRecord(sse.delta);
      const deltaType = optionalString(delta.type);
      if (deltaType === "text_delta") {
        const text = String(delta.text || "");
        if (text) {
          this.streamedText = true;
          this.emit({ type: "stream_delta", delta: text });
        }
        return;
      }
      if (deltaType === "thinking_delta") {
        const thinking = String(delta.thinking || "");
        if (thinking) {
          this.thinkingOpen = true;
          this.thinkingStreamed = true;
          this.emit({ type: "thinking_delta", delta: thinking });
        }
        return;
      }
    }
    if (sseType === "content_block_stop" && this.thinkingOpen) {
      this.thinkingOpen = false;
      this.emit({ type: "thinking_end" });
    }
  }

  /** 引导追加的新一轮响应到来时，重新开一个气泡（上一轮 result 已经收过 stream_end）。 */
  private ensureMidTurnStreamStart(): void {
    if (!this.resultSeen) return;
    this.resultSeen = false;
    this.emit({ type: "stream_start", role: "assistant" });
  }

  /** 把 CLI 的 TaskCreate/TaskUpdate 工具转成 Hpp 的原生计划步骤。 */
  private handleTaskTool(toolCallId: string, toolName: string, input: Record<string, unknown>): boolean {
    if (toolName === "TaskCreate") {
      const title = optionalString(input.subject) || optionalString(input.title);
      if (!title) return true;
      const step: AgentProcessStep = {
        id: `codebuddy-task-${this.planSteps.length + 1}-${toolCallId}`,
        title,
        status: "pending",
      };
      this.planSteps = [...this.planSteps, step];
      this.taskToolIds.set(toolCallId, step.id);
      this.emitPlanSteps();
      return true;
    }
    if (toolName === "TaskUpdate") {
      this.taskToolIds.set(toolCallId, "");
      const taskId = optionalString(input.taskId) || optionalString(input.task_id);
      const status = optionalString(input.status);
      if (!taskId) return true;
      // CLI 的 taskId 是 "1"/"2"...，对应我们按创建顺序记的步骤。
      const index = Number(taskId) - 1;
      const step = this.planSteps[index];
      if (step) {
        const normalized = status === "in_progress" ? "running"
          : status === "completed" ? "completed" : step.status;
        this.planSteps = this.planSteps.map((item, i) => (i === index ? { ...item, status: normalized } : item));
        this.emitPlanSteps();
      }
      return true;
    }
    return false;
  }

  /**
   * ExitPlanMode 到了：CLI 在等用户批准，不会自己给 result。
   * 关掉 stdin 让它退出，由 close 路径正常收尾。Hpp 的 Plan 开关就是"批准"——
   * 用户关掉开关再发消息，下一轮按普通模式执行计划。
   */
  private finishPlanTurn(): void {
    this.resultSeen = true;
    this.closeStdin();
    // CLI 可能仍在等批准结果而不退出；给一点时间后强制结束。
    setTimeout(() => {
      if (this.turnActive) this.killProcess();
    }, 3000).unref?.();
  }

  private emitPlanSteps(): void {
    this.emit({ type: "plan_update", steps: this.planSteps.map((step) => ({ ...step })) });
  }

  private handleAssistantMessage(event: UnknownRecord): void {
    this.ensureMidTurnStreamStart();
    const message = asRecord(event.message);
    const parentToolCallId = optionalString(event.parent_tool_use_id);
    for (const rawBlock of asArray(message.content)) {
      const block = asRecord(rawBlock);
      const blockType = optionalString(block.type);
      if (blockType === "text") {
        const text = String(block.text || "");
        // 流式已经发过就不重复整段文本。
        if (text && !this.streamedText) this.emit({ type: "stream_delta", delta: text });
        continue;
      }
      if (blockType === "thinking") {
        const thinking = String(block.thinking || "");
        // 流式已发过就不再重发整段思考（否则助手消息会把同一段 thinking 再开一个气泡）。
        if (thinking && !this.thinkingStreamed && !this.thinkingOpen) {
          this.thinkingStreamed = true;
          this.thinkingOpen = true;
          this.emit({ type: "thinking_delta", delta: thinking });
        }
        // 无论内容从哪条路径来，这里都负责把思考气泡收尾。
        if (this.thinkingOpen) {
          this.thinkingOpen = false;
          this.emit({ type: "thinking_end" });
        }
        continue;
      }
      if (blockType === "tool_use") {
        const toolCallId = optionalString(block.id);
        const toolName = optionalString(block.name) || "tool";
        if (!toolCallId) continue;
        this.toolNames.set(toolCallId, toolName);
        if (this.startedTools.has(toolCallId)) continue;
        this.startedTools.add(toolCallId);
        // Plan 模式下 CLI 用 TaskCreate/TaskUpdate 表达计划步骤。它们转成
        // plan_update，不显示成普通工具卡片（与 WorkBuddy 桌面端一致）。
        if (this.handleTaskTool(toolCallId, toolName, asRecord(block.input))) continue;
        // ExitPlanMode 只是"计划已完成"的信号，CLI 不会给 result（它等用户批准），
        // 不显示成工具卡片。收到它就收尾本轮，把裁定权交回 Hpp 的 Plan 开关。
        if (this.planModeActive && toolName === "ExitPlanMode") {
          this.taskToolIds.set(toolCallId, "");
          this.finishPlanTurn();
          continue;
        }
        this.emit(normalizeToolEvent("tool_start", {
          toolName,
          toolCallId,
          args: block.input,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        }));
      }
    }
    const usage = asRecord(message.usage);
    this.emitUsage(usage);
  }

  private handleUserMessage(event: UnknownRecord): void {
    const message = asRecord(event.message);
    for (const rawBlock of asArray(message.content)) {
      const block = asRecord(rawBlock);
      if (optionalString(block.type) !== "tool_result") continue;
      const toolCallId = optionalString(block.tool_use_id);
      if (!toolCallId || this.finishedTools.has(toolCallId)) continue;
      this.finishedTools.add(toolCallId);
      // Task 工具已转成 plan_update，不要再发一条孤立的 tool_end。
      if (this.taskToolIds.has(toolCallId)) continue;
      this.emit(normalizeToolEvent("tool_end", {
        toolName: this.toolNames.get(toolCallId) || "tool",
        toolCallId,
        result: block.content,
        isError: block.is_error === true,
      }));
    }
  }

  private handleResult(event: UnknownRecord, revision: number): void {
    if (this.turnKind === "compact") {
      if (event.is_error === true) {
        const errors = asArray(event.errors).map(describeError).filter(Boolean);
        const detail = truncate(
          errors.join("\n")
          || truncateTail(this.stderrTail.trim(), 4_000)
          || "CodeBuddy 压缩上下文失败",
        );
        this.settleCompaction(revision, false, detail);
      } else if (this.compactBoundarySeen) {
        this.settleCompaction(revision, true);
      }
      // 没有边界时先不判死：结果可能先于 compact_boundary 到达，交给 close 收尾。
      return;
    }
    // 逐次响应的 usage 已经在 handleAssistantMessage 里累加过；result 里的总量
    // 再发一次会让 Hpp 翻倍。只有一次都没拿到时才用 result 兜底。
    if (!this.usageReported) this.emitUsage(asRecord(event.usage));
    if (event.is_error === true) {
      const errors = asArray(event.errors).map(describeError).filter(Boolean);
      const detail = truncate(
        errors.join("\n")
        || truncateTail(this.stderrTail.trim(), 4_000)
        || "CodeBuddy 请求失败",
      );
      this.emit({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "CodeBuddy 请求失败",
        detail,
        state: "error",
      });
      this.pendingGuidance = 0;
      this.resultSeen = true;
      this.closeStdin();
      return;
    }
    this.resultSeen = true;
    if (this.pendingGuidance > 0) {
      // 这条 result 属于引导追加之前的回合：收掉当前气泡，但保持进程和 stdin 打开，
      // 追加的消息会产生新的 assistant + result，由那一条 result 负责收尾。
      this.pendingGuidance -= 1;
      this.emit({ type: "stream_end" });
      this.streamedText = false;
      this.thinkingOpen = false;
      this.thinkingStreamed = false;
      this.usageReported = false;
      this.contextReported = false;
      return;
    }
    // 没有等待中的引导：关闭 stdin 让 CLI 退出，由 close 统一收尾。
    this.closeStdin();
  }

  private closeStdin(): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.writableEnded) return;
    try {
      stdin.end();
    } catch {
      // 进程可能已经退出，close 分支会收尾。
    }
  }

  private clearGuidanceTimeout(): void {
    if (!this.guidanceTimeout) return;
    clearTimeout(this.guidanceTimeout);
    this.guidanceTimeout = null;
  }

  /**
   * 运行中往当前 CLI 进程追加一条用户消息（Hpp 的“引导/插入对话”）。
   *
   * CLI 的 stream-json 输入支持多轮：追加的消息会在当前响应 result 之后被处理，
   * 产生新的 assistant + result。最后一条 result 到达时 Hpp 才关闭 stdin。
   */
  async sendGuidance(
    message: string,
    images?: AgentImagePayload,
    _options?: AgentSendOptions,
  ): Promise<{ guidanceId: string }> {
    if (this.turnKind !== "chat" || !this.turnActive || !this.proc) {
      throw new Error("SESSION_NOT_RUNNING");
    }
    const stdin = this.proc.stdin;
    if (!stdin || stdin.writableEnded || stdin.destroyed) throw new Error("SESSION_NOT_RUNNING");

    const guidanceId = `codebuddy-guidance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const input = buildStreamJsonUserMessage(message, normalizeImagePayload(images));
    try {
      stdin.write(input);
    } catch (error) {
      throw new Error(`写入引导消息失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.pendingGuidance += 1;
    // 告诉渲染层这条引导已经交付给 CLI，否则队列项会一直停在“等待插入”，
    // 要等 GUIDANCE_CONFIRM_TIMEOUT_MS 兜底才确认（本机已经能复现这种卡顿）。
    this.emit({ type: "guidance_response_started" });
    this.clearGuidanceTimeout();
    this.guidanceTimeout = setTimeout(() => {
      this.guidanceTimeout = null;
      if (this.pendingGuidance <= 0) return;
      // CLI 没给追加消息任何结果：杀掉进程并结束回合，不能让会话一直占用。
      this.pendingGuidance = 0;
      this.killProcess();
    }, 60_000);
    this.guidanceTimeout.unref?.();
    return { guidanceId };
  }

  async cancelGuidance(_guidanceId: string): Promise<{ cancelled: boolean; reason?: string }> {
    // 消息已经写进 stdin，CLI 侧没有撤回接口。
    return { cancelled: false, reason: "CodeBuddy 引导消息已发出，无法撤回。" };
  }

  private emitUsage(usage: UnknownRecord): void {
    if (this.turnKind === "compact") return;
    const inputTokens = Number(usage.input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return;
    if (inputTokens <= 0 && outputTokens <= 0) return;
    const readCache = Number(usage.cache_read_input_tokens || 0);
    const createdCache = Number(usage.cache_creation_input_tokens || 0);
    const cacheInputTokens = Number.isFinite(readCache) && readCache > 0 ? readCache : 0;
    const promptTokens = inputTokens
      + cacheInputTokens
      + (Number.isFinite(createdCache) && createdCache > 0 ? createdCache : 0);
    const window = this.resolveContextWindow();
    this.usageReported = true;
    this.emit({
      type: "token_usage",
      inputTokens,
      outputTokens,
      ...(cacheInputTokens > 0 ? { cacheInputTokens } : {}),
      // 上下文优先用 usage_update 的精确值；这里只在该回合还没拿到精确读数时兜底。
      ...(!this.contextReported && promptTokens > 0
        ? {
          contextTokens: promptTokens,
          ...(window ? { contextWindow: window } : {}),
          contextPrecision: "estimated",
        }
        : {}),
    });
  }

  private handleClose(revision: number, code: number | null): void {
    if (revision !== this.turnRevision) return;
    if (this.turnKind === "compact") {
      if (this.compactBoundarySeen) {
        this.settleCompaction(revision, true);
      } else {
        const detail = truncateTail(this.stderrTail.trim(), 4_000)
          || `CodeBuddy CLI 进程退出（code=${code ?? "?"}）`;
        this.settleCompaction(revision, false, detail);
      }
      return;
    }
    if (!this.resultSeen) {
      const detail = truncateTail(this.stderrTail.trim(), 4_000)
        || `CodeBuddy CLI 进程退出（code=${code ?? "?"}）`;
      this.emit({
        type: "process_event",
        entryType: "error",
        kind: "error",
        title: "CodeBuddy CLI 提前退出",
        detail,
        state: "error",
      });
    }
    this.finishTurn(revision);
  }

  private failTurn(revision: number, detail: string): void {
    if (revision !== this.turnRevision) return;
    if (this.turnKind === "compact") {
      this.settleCompaction(revision, false, truncate(detail));
      return;
    }
    this.emit({
      type: "process_event",
      entryType: "error",
      kind: "error",
      title: "CodeBuddy 运行失败",
      detail: truncate(detail),
      state: "error",
    });
    this.finishTurn(revision);
  }

  private finishTurn(revision: number): void {
    if (revision !== this.turnRevision) return;
    this.turnRevision += 1;
    this.turnActive = false;
    this.proc = null;
    this.clearGuidanceTimeout();
    this.emit({ type: "stream_end" });
    this.emit({ type: "agent_end" });
  }

  private killProcess(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.killed || typeof proc.pid !== "number") return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { windowsHide: true });
      } else {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // 进程已退出。
          }
        }, 1_500).unref?.();
      }
    } catch {
      // 进程可能已经退出。
    }
  }

  private emit(data: unknown): void {
    this.eventBuffer.send(data);
  }
}