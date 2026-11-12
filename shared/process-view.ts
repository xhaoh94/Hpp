import { MESSAGE_WRAPPER_TAG, stripInternalTags } from "./message-internal-tags";

export type ProcessSubagentStopReason = "timeout" | "aborted" | "cancelled" | "error";

export type ProcessSubagentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  turns?: number;
};

export type ProcessEntryView = {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking" | "question" | "subagent";
  kind?: "assistant_narration" | "user_guidance";
  title: string;
  toolKind?: string;
  detail?: string;
  prompt?: string;
  command?: string;
  /** 模型写的一句话意图（命令条目标题），没有时退回 command。 */
  description?: string;
  exitCode?: number;
  state?: "running" | "completed" | "warning" | "error" | "interrupted";
  files?: unknown[];
  timestamp?: number;
  startedAt?: number;
  completedAt?: number;
  phase?: "started" | "completed";
  stopReason?: ProcessSubagentStopReason;
  /** 「标准」档操作摘要的明细：展开时按类别列出（命令 / 改过的文件 / 看过的文件）。 */
  operationSummary?: {
    commandCount: number;
    changedFiles: string[];
    viewedFiles: string[];
    /** 每条命令单独一行显示（标题用模型写的 description）。 */
    commandItems?: ProcessOperationCommandItem[];
  };
  subagents?: Array<{
    id?: string;
    label?: string;
    status?: "pending" | "running" | "completed" | "error" | "interrupted";
    model?: string;
    path?: string;
    message?: string;
    prompt?: string;
    stopReason?: ProcessSubagentStopReason;
    usage?: ProcessSubagentUsage;
    /** 子任务自己的时间线（不是整次工具调用的）；老后端可能没有。 */
    startedAt?: number;
    completedAt?: number;
    lastActivityAt?: number;
    /** 运行中的实时输出片段（尾巴），仅用于监视窗。 */
    liveOutput?: string;
  }>;
};

export type ProcessSubagentView = NonNullable<ProcessEntryView["subagents"]>[number];

const isTerminalProcessSubagentStatus = (status?: ProcessSubagentView["status"]) => (
  status === "completed" || status === "error" || status === "interrupted"
);

/** 返回并行 Subagent 的实时完成进度；单任务不显示无意义的分数。 */
export const getSubagentProgressLabel = (subagents: ProcessSubagentView[]) => {
  if (subagents.length < 2) return "";
  const finished = subagents.filter((subagent) => isTerminalProcessSubagentStatus(subagent.status)).length;
  return `进度 ${finished}/${subagents.length}`;
};

/** 返回当前正在工作的 Subagent 最近一次活动，供摘要行实时展示。 */
export const getSubagentActivityLabel = (subagents: ProcessSubagentView[]) => {
  const active = subagents.find((subagent) => (
    (subagent.status === "running" || subagent.status === "pending") && subagent.message?.trim()
  ));
  if (active) return `${active.label || "Subagent"}：${active.message!.trim()}`;

  const waiting = subagents.find((subagent) => subagent.status === "pending");
  if (waiting) return `${waiting.label || "Subagent"}：等待启动…`;

  const running = subagents.find((subagent) => subagent.status === "running");
  return running ? `${running.label || "Subagent"}：正在工作…` : "";
};

export const isTerminalProcessEntryState = (state?: ProcessEntryView["state"]) => (
  state === "completed" || state === "error" || state === "interrupted"
);

/**
 * 早期占位项的 id 就是裸工具调用 id，而真实子任务是 `toolCallId:N`，两者会一起挂在这个条目上。
 * 占位项收不到后续事件，进度会永远停在 1/2。特征是：有兄弟 id 等于它加 `:` 前缀。
 * 条目本身已结束时，还停在 running/pending 的同样算残留。
 */
export const getEffectiveProcessSubagents = <T extends ProcessSubagentView>(
  subagents: T[] | undefined,
  entryState?: ProcessEntryView["state"],
): T[] => {
  const list = subagents || [];
  const terminalEntry = isTerminalProcessEntryState(entryState);
  const isPlaceholder = (id?: string) => !!id && list.length > 1 && list.some((other) => (
    !!other.id && other.id !== id && other.id.startsWith(`${id}:`)
  ));
  return list.filter((subagent) => {
    if (isPlaceholder(subagent.id)) return false;
    return !terminalEntry || !subagent.status || isTerminalProcessSubagentStatus(subagent.status);
  });
};

export type ProcessPlanStepView = {
  status: string;
};

export type ProcessPlanStepsSource = "native" | "inferred";

export type ProcessView<
  TEntry extends ProcessEntryView = ProcessEntryView,
  TStep extends ProcessPlanStepView = ProcessPlanStepView,
> = {
  startedAt: number;
  endedAt?: number;
  entries: TEntry[];
  planSteps?: TStep[];
  planStepsSource?: ProcessPlanStepsSource;
};

export type ProcessTerminalViewState = "completed" | "error" | "interrupted";

export const hasNativeProcessPlan = (
  process?: Pick<ProcessView, "planSteps" | "planStepsSource">,
) => process?.planStepsSource === "native" && !!process.planSteps?.length;

/**
 * The floating Todo summary is reserved for plans that actually contain
 * multiple steps. A single native step is useful inside the process details,
 * but is not enough to justify a persistent bottom capsule.
 */
export const hasNativeMultiStepProcessPlan = (
  process?: Pick<ProcessView, "planSteps" | "planStepsSource">,
) => process?.planStepsSource === "native" && (process.planSteps?.length || 0) > 1;

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isProcessViewRunning = (
  process: Pick<ProcessView, "startedAt" | "endedAt">,
  turnRunning = true,
) => turnRunning && !isFiniteTimestamp(process.endedAt);

export function getActiveAssistantTurnId<
  TMessage extends {
    id: string;
    role: string;
    content?: string;
    timestamp?: number;
    isStreaming?: boolean;
    systemType?: string;
    compactionState?: string;
    process?: Pick<ProcessView, "endedAt">;
    commentary?: Array<{ isStreaming?: boolean }>;
  },
>(messages: TMessage[], sessionRunning: boolean): string | null {
  if (!sessionRunning) return null;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  let compactionBoundaryAt: number | null = null;
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    // A compaction divider is a chronological boundary after the assistant
    // turn, including the short interval between the completed/interrupted
    // divider update and the catalog status settling. It must not lend a
    // newer session-level `running` state to an older orphaned process.
    // A legitimate post-compaction continuation is inserted before the
    // divider but has a newer timestamp, and is therefore still accepted.
    if (message.role === "system" && message.systemType === "context_compaction") {
      const timestamp = isFiniteTimestamp(message.timestamp) ? message.timestamp : Number.POSITIVE_INFINITY;
      compactionBoundaryAt = compactionBoundaryAt === null ? timestamp : Math.max(compactionBoundaryAt, timestamp);
      continue;
    }
    if (message.role !== "assistant") continue;
    if (compactionBoundaryAt !== null && (!isFiniteTimestamp(message.timestamp) || message.timestamp <= compactionBoundaryAt)) {
      return null;
    }
    const processEnded = !!message.process && isFiniteTimestamp(message.process.endedAt);
    const processOpen = !!message.process && !processEnded;
    const commentaryStreaming = message.commentary?.some((item) => item.isStreaming === true) === true;
    // A persisted process end is authoritative. Stale message/commentary
    // streaming flags must not reclaim the session-level running state (for
    // example while a later context compaction keeps the session busy).
    if (processEnded) return null;
    // A streaming body is still the active turn even after its first chunk.
    if (message.isStreaming === true) return message.id;
    // Hpp stores only the final assistant body in message.content; commentary
    // lives in its own field. Once a non-streaming final body is present, an
    // absent process endedAt or stale commentary flag must not keep timers
    // alive. Do not inspect commentary text here: it is not final-body proof.
    if (typeof message.content === "string" && message.content.trim().length > 0) return null;
    if (processOpen || (commentaryStreaming && !message.process)) return message.id;
    // Message order is authoritative. Once the latest assistant after the
    // last user is terminal, an older orphaned process cannot own a newer
    // session-level running status (for example while compacting context).
    return null;
  }
  return null;
}

function getProcessTerminalTimestamp(
  process: ProcessView,
  fallbackEndedAt?: number,
) {
  const startedAt = isFiniteTimestamp(process.startedAt) ? process.startedAt : 0;
  if (isFiniteTimestamp(process.endedAt)) return Math.max(startedAt, process.endedAt);
  const candidates = [startedAt, fallbackEndedAt];
  for (const entry of process.entries) {
    candidates.push(entry.timestamp, entry.startedAt, entry.completedAt);
  }
  return Math.max(startedAt, ...candidates.filter(isFiniteTimestamp));
}

export function normalizeProcessForView<
  TEntry extends ProcessEntryView,
  TStep extends ProcessPlanStepView,
  TProcess extends ProcessView<TEntry, TStep>,
>(
  process: TProcess,
  options: {
    running: boolean;
    terminalState?: ProcessTerminalViewState;
    fallbackEndedAt?: number;
  },
): TProcess & { endedAt: number } | TProcess {
  if (isProcessViewRunning(process, options.running)) return process;
  const terminalState = options.terminalState || "completed";
  const endedAt = getProcessTerminalTimestamp(process, options.fallbackEndedAt);
  const subagentTerminalState = terminalState === "completed" ? "completed" : terminalState;
  const planTerminalState = terminalState === "completed"
    ? "completed"
    : terminalState === "error" ? "failed" : "cancelled";
  const entries = process.entries.map((entry) => {
    const hadStartedPhase = entry.phase === "started";
    const wasRunning = entry.state === "running" || hadStartedPhase;
    const subagents = entry.subagents?.map((subagent) => (
      subagent.status === "pending" || subagent.status === "running"
        ? { ...subagent, status: subagentTerminalState }
        : subagent
    ));
    if (!wasRunning && subagents?.every((subagent, index) => subagent === entry.subagents?.[index])) {
      return entry;
    }
    return {
      ...entry,
      ...(wasRunning ? {
        state: entry.state === "running" || entry.state === undefined
          ? terminalState
          : entry.state,
        phase: hadStartedPhase ? "completed" : entry.phase,
        completedAt: isFiniteTimestamp(entry.completedAt) ? entry.completedAt : endedAt,
      } : {}),
      ...(subagents ? { subagents } : {}),
    } as TEntry;
  });
  const planSteps = process.planSteps?.map((step) => (
    step.status === "pending" || step.status === "running"
      ? { ...step, status: planTerminalState } as TStep
      : step
  ));
  return {
    ...process,
    endedAt,
    entries,
    ...(planSteps ? { planSteps } : {}),
  } as TProcess & { endedAt: number };
}

export type ProcessEntryGroup<T extends ProcessEntryView> =
  | { kind: "entry"; entry: T }
  | { kind: "commands"; entries: T[] }
  | { kind: "files"; entries: T[] };

export function formatProcessDuration(ms: number) {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export const isCommandProcessEntry = (entry: ProcessEntryView) =>
  entry.toolKind === "run_command" || (
    entry.type === "tool" && /^(?:已运行|正在运行)\s+/.test(entry.title)
  );

export const isFileOperationProcessEntry = (entry: ProcessEntryView) =>
  entry.type === "tool" &&
  ["read_file", "list_dir", "write_file", "edit_file"].includes(entry.toolKind || "") &&
  Boolean(entry.files?.length);

export const ASSISTANT_NARRATION_PROCESS_KIND = "assistant_narration" as const;
export const USER_GUIDANCE_PROCESS_KIND = "user_guidance" as const;

/**
 * 把所有连续的思考合并成一条，让整轮思考和正文一样连成一段，而不是被每条
 * 思考各占一行拆散。三个详细等级（简洁/标准/详细）都走同一套规则。
 *
 * 合并只在“相邻”时发生：调用方按时间顺序传入条目，中间一旦插入了正文
 * （commentary / assistant_narration / 引导），或查看文件、命令等任何其他
 * 条目，就会自然断开，形成新的一组思考——这些条目始终是思考之间的分界点。
 *
 * 合并后的条目沿用第一条的 id（保持列表 key 稳定），正文按顺序用空行
 * 拼接，时间戳取区间起点。
 */
export function mergeThinkingEntries<T extends ProcessEntryView>(entries: T[]): T[] {
  const merged: T[] = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (previous && entry.type === "thinking" && previous.type === "thinking") {
      // 按「段落」去重，而不是拿两条完整的 detail 两两比较：
      // previous 可能是已经拼接过的 "A\n\nB"，再来一条 "B" 时两两比较会重复拼。
      const parts = String(previous.detail || "")
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);
      for (const part of String(entry.detail || "").split(/\n{2,}/).map((item) => item.trim())) {
        if (part && !parts.includes(part)) parts.push(part);
      }
      merged[merged.length - 1] = {
        ...previous,
        detail: parts.join("\n\n"),
        // 末条没带 state 时保留前一条的，避免把运行态抹成 undefined。
        state: entry.state ?? previous.state,
        completedAt: entry.completedAt ?? previous.completedAt,
      };
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

export const isAssistantNarrationProcessEntry = (entry: ProcessEntryView) =>
  entry.kind === ASSISTANT_NARRATION_PROCESS_KIND;

export const isUserGuidanceProcessEntry = (entry: ProcessEntryView) =>
  entry.kind === USER_GUIDANCE_PROCESS_KIND ||
  entry.toolKind === "guidance_message" ||
  entry.toolKind === "guidance" ||
  /^收到引导(?:[:：]|$)/.test(entry.title);

/**
 * 操作类条目：执行命令、读取/查看文件、修改文件、diff。
 * 标准档把它们合并成摘要；简洁档按两段主体重组，不在这里复用。
 */
export const isOperationProcessEntry = (entry: ProcessEntryView) =>
  entry.type === "diff"
  || (entry.type === "tool"
    && entry.toolKind !== "guidance_message"
    && entry.toolKind !== "guidance");

/** 历史上只带标题、没有 kind 的正文节点。 */
export const PROCESS_NARRATION_TITLE = "正文输出";

/** 简洁档的正文节点：narration 条目或历史上只带标题的正文节点。 */
const isConciseBodyEntry = (entry: ProcessEntryView) =>
  isAssistantNarrationProcessEntry(entry) || entry.title === PROCESS_NARRATION_TITLE;

/** 简洁档的例外：交互、结果与变更条目必须原样可见，不能被两段合并吞掉。 */
const isConciseExceptionEntry = (entry: ProcessEntryView) =>
  entry.type === "question"
  || entry.type === "error"
  || entry.type === "diff"
  || isUserGuidanceProcessEntry(entry)
  // 中断的命令仍是操作细节，继续隐藏；只保留中断的状态/思考/正文。
  || (entry.state === "interrupted" && entry.type !== "tool");

/** 正文按段落拼接去重；历史 commentary 与 narration 可能有重叠段落。 */
export function mergeProcessBodyText(texts: string[]): string {
  const parts: string[] = [];
  for (const text of texts) {
    for (const part of String(text || "").split(/\n{2,}/).map((item) => item.trim())) {
      if (part && !parts.includes(part)) parts.push(part);
    }
  }
  return parts.join("\n\n");
}

function mergeBodyEntries<T extends ProcessEntryView>(entries: T[]): T {
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    ...first,
    detail: mergeProcessBodyText(entries.map((entry) => String(entry.detail || ""))),
    state: last.state ?? first.state,
    completedAt: last.completedAt ?? first.completedAt,
  };
}

/**
 * 把独立的 commentary 正文折成一个 narration 条目，让简洁档两段合并只走
 * ProcessEntries 这一条渲染路径；否则正文会散在时间线里，永远合不起来。
 */
export function buildConciseCommentaryEntry<T extends ProcessEntryView>(
  commentary: Array<{ id: string; content: string; timestamp: number; isStreaming?: boolean }>,
): T | null {
  const parts = commentary.filter((item) => item.content.trim().length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  return {
    id: `concise-commentary-${parts[0].id}`,
    type: "info",
    kind: ASSISTANT_NARRATION_PROCESS_KIND,
    title: PROCESS_NARRATION_TITLE,
    detail: mergeProcessBodyText(parts.map((item) => item.content)),
    timestamp: parts[0].timestamp,
    state: last.isStreaming ? "running" : "completed",
  } as T;
}

/**
 * 「简洁」档按例外分段：每段内所有思考合成一条、所有正文合成一条，
 * 例外（引导/问卷/错误/子 Agent/diff）作为分界点原样保留。
 * 引导是用户介入点，跨过它合并会让引导前后的思考看起来颠倒了顺序。
 */
export const getConciseProcessEntries = <T extends ProcessEntryView>(entries: T[]): T[] => {
  const result: T[] = [];
  let thinking: T[] = [];
  let body: T[] = [];
  let thinkingIndex = 0;
  let bodyIndex = 0;

  const flush = () => {
    const blocks: Array<{ index: number; entry: T }> = [];
    if (thinking.length > 0) {
      const [merged] = mergeThinkingEntries(thinking);
      blocks.push({ index: thinkingIndex, entry: merged });
    }
    if (body.length > 0) {
      blocks.push({ index: bodyIndex, entry: mergeBodyEntries(body) });
    }
    result.push(...blocks.sort((left, right) => left.index - right.index).map((item) => item.entry));
    thinking = [];
    body = [];
  };

  entries.forEach((entry, index) => {
    if (isConciseExceptionEntry(entry)) {
      flush();
      result.push(entry);
      return;
    }
    if (entry.type === "thinking") {
      if (thinking.length === 0) thinkingIndex = index;
      thinking.push(entry);
    } else if (isConciseBodyEntry(entry)) {
      if (body.length === 0) bodyIndex = index;
      body.push(entry);
    }
  });
  flush();
  return result;
};

/** 「标准」档把操作类条目合并成的那一条的标识。 */
export const OPERATION_SUMMARY_TOOL_KIND = "operation_summary" as const;

/** 摘要里最多列出多少个文件名，超出的部分只报数量。 */
const OPERATION_SUMMARY_FILE_LIMIT = 8;

type OperationFileRef = { name: string; action?: string };

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 从条目的 files 里取出「文件名 + 动作」（action 决定算查看还是修改）。 */
const getOperationFileRefs = (entry: ProcessEntryView): OperationFileRef[] =>
  (entry.files || []).flatMap((file) => {
    if (typeof file === "string") {
      return file.trim() ? [{ name: file.trim() as string }] : [];
    }
    if (!isRecordLike(file) || typeof file.file !== "string") return [];
    const name = file.file.trim();
    if (!name) return [];
    return [{ name, action: typeof file.action === "string" ? file.action : undefined }];
  });

const isWriteFileAction = (action?: string) =>
  action === "edited" || action === "modified" || action === "written";

export type ProcessOperationCommandItem = {
  id: string;
  description?: string;
  command?: string;
};

type OperationSummary = {
  commandCount: number;
  changedFiles: string[];
  viewedFiles: string[];
};

const summarizeOperations = (operations: ProcessEntryView[]): OperationSummary => {
  let commandCount = 0;
  const changedFiles: string[] = [];
  const viewedFiles: string[] = [];
  for (const entry of operations) {
    const files = getOperationFileRefs(entry);
    if (entry.type === "diff") {
      // diff 条目本身就是“改了这些文件”。
      changedFiles.push(...files.map((file) => file.name));
      if (files.length === 0) commandCount += 0;
      continue;
    }
    if (entry.command?.trim() || files.length === 0) commandCount += 1;
    for (const file of files) {
      if (isWriteFileAction(file.action)) changedFiles.push(file.name);
      else viewedFiles.push(file.name);
    }
  }
  return { commandCount, changedFiles, viewedFiles };
};

const uniqueNames = (names: string[]) => Array.from(new Set(names.filter(Boolean)));

/** 一行里列文件名：超过上限只报数量，避免摘要被路径撑爆。 */
const formatFileNames = (names: string[]) => {
  const visible = names.slice(0, OPERATION_SUMMARY_FILE_LIMIT);
  const rest = names.length - visible.length;
  return rest > 0 ? `${visible.join("、")} 等 ${names.length} 个文件` : visible.join("、");
};

const buildOperationSummaryEntry = <T extends ProcessEntryView>(
  first: T,
  operations: T[],
  title: string,
  summary: OperationSummary,
): T => ({
  ...first,
  // 合成条目的 id 随首个操作稳定，列表 key 不会每次重渲染就变。
  id: `${first.id}-operation-summary`,
  type: "status" as const,
  toolKind: OPERATION_SUMMARY_TOOL_KIND,
  title,
  // 明细留给渲染层：展开时按「已运行 / 已修改 / 已查看」分三行，文件名可点击。
  operationSummary: {
    commandCount: summary.commandCount,
    changedFiles: uniqueNames(summary.changedFiles),
    viewedFiles: uniqueNames(summary.viewedFiles),
    commandItems: operations
      .filter(isCommandProcessEntry)
      .map((entry) => ({
        id: entry.id,
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.command ? { command: entry.command } : {}),
      })),
  },
  detail: undefined,
  command: undefined,
  files: undefined,
  state: operations.some((entry) => entry.state === "running") ? "running" as const : "completed" as const,
}) as T;

/**
 * 「标准」等级（收起态）：把**连续的**操作类条目（命令 / 读文件 / 改文件）
 * 汇总成一条，放在该段第一个操作的位置。
 *
 * 思考、正文、提问、提示会打断合并：它们之间的操作属于不同阶段，混成一条
 * 会让人分不清"这段回话到底跑了什么"。没有操作类条目时原样返回。
 */
export function collapseOperationProcessEntries<T extends ProcessEntryView>(entries: T[]): T[] {
  if (!entries.some(isOperationProcessEntry)) return entries;

  const result: T[] = [];
  let run: T[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const { commandCount, changedFiles, viewedFiles } = summarizeOperations(run);
    const parts = [
      commandCount > 0 ? `运行 ${commandCount} 条命令` : "",
      uniqueNames(viewedFiles).length > 0 ? `查看 ${uniqueNames(viewedFiles).length} 个文件` : "",
      uniqueNames(changedFiles).length > 0 ? `修改 ${uniqueNames(changedFiles).length} 个文件` : "",
    ].filter(Boolean);
    if (parts.length === 0) {
      result.push(...run);
    } else {
      result.push(buildOperationSummaryEntry(run[0], run, parts.join(" · "), {
        commandCount,
        changedFiles,
        viewedFiles,
      }));
    }
    run = [];
  };

  for (const entry of entries) {
    if (isOperationProcessEntry(entry)) {
      run.push(entry);
      continue;
    }
    flushRun();
    result.push(entry);
  }
  flushRun();
  return result;
}



/**
 * 「标准」等级的最终形态：同一段里所有思考合成一块、所有操作合成一块，
 * 正文/提问/错误等「其他条目」照旧打断分段。
 *
 * 例：T op T op 正文 T op → [思考(T+T)] [操作(op+op)] 正文 [思考(T)] [操作(op)]。
 * 两块的先后按该段里先出现的类别决定，不强行把思考提到最前面。
 */
export function collapseStandardProcessEntries<T extends ProcessEntryView>(entries: T[]): T[] {
  const result: T[] = [];
  let thinking: T[] = [];
  let operations: T[] = [];
  let firstCategory: "thinking" | "operation" | null = null;

  const flushSegment = () => {
    const pushThinking = () => {
      if (thinking.length === 0) return;
      result.push(...mergeThinkingEntries(thinking));
      thinking = [];
    };
    const pushOperations = () => {
      if (operations.length === 0) return;
      result.push(...collapseOperationProcessEntries(operations));
      operations = [];
    };
    if (firstCategory === "operation") {
      pushOperations();
      pushThinking();
    } else {
      pushThinking();
      pushOperations();
    }
    firstCategory = null;
  };

  for (const entry of entries) {
    if (entry.type === "thinking") {
      firstCategory ??= "thinking";
      thinking.push(entry);
      continue;
    }
    if (isOperationProcessEntry(entry)) {
      firstCategory ??= "operation";
      operations.push(entry);
      continue;
    }
    flushSegment();
    result.push(entry);
  }
  flushSegment();
  return result;
}

/**
 * 引导气泡的兜底文本。旧版本没有分开保存展示/发送正文，历史记录里可能留着
 * 发给 Agent 的信封 XML（`<folder path="…" />` 等），渲染前统一规范化。
 * 保留行结构：引导内容按行显示，不做空白压缩。
 */
const sanitizeGuidanceText = (value: string) =>
  stripInternalTags(String(value || "")).replace(MESSAGE_WRAPPER_TAG, "").trim();

export const getUserGuidanceText = (entry: ProcessEntryView) => {
  const isLegacyEntry = /^收到引导(?:[:：]|$)/.test(entry.title);
  if (isLegacyEntry) {
    const legacyTitle = entry.title
      .replace(/^收到引导\s*[:：]?\s*/, "")
      .replace(/^["“](.*)["”]$/, "$1")
      .trim();
    return sanitizeGuidanceText(legacyTitle || entry.detail || "");
  }
  if (entry.detail?.trim()) return sanitizeGuidanceText(entry.detail);
  return entry.title === "引导" ? "" : sanitizeGuidanceText(entry.title);
};

export function getVisibleProcessEntries<T extends ProcessEntryView>(entries: T[]) {
  return entries.flatMap((entry) => {
    // 「Pi 仍在运行，暂时没有新输出」这类空闲提示已下线；历史会话里残留的
    // 条目同样不展示（数据保留，只是渲染层过滤）。
    if (entry.toolKind === "stream_idle_notice") return [];
    // `message_received` used to duplicate the user's bubble inside the
    // process timeline. Keep persisted records intact, but never display the
    // redundant row on either desktop or mobile clients.
    if (entry.toolKind === "message_received" || /^收到消息(?:[:：]|$)/.test(entry.title)) {
      return [];
    }
    return !isAssistantNarrationProcessEntry(entry) || Boolean(entry.detail?.trim())
      ? [entry]
      : [];
  });
}

export function splitCommandDetail(entry: Pick<ProcessEntryView, "detail" | "command">) {
  if (!entry.detail) return { command: entry.command || "", output: "" };
  const lines = entry.detail.split("\n");
  if ((lines[0] || "").startsWith("$ ")) {
    return {
      command: entry.command || lines[0].slice(2).trim(),
      output: lines.slice(1).join("\n").trim(),
    };
  }
  return { command: entry.command || "", output: entry.detail.trim() };
}

export function groupProcessEntries<T extends ProcessEntryView>(
  entries: T[],
  options: { groupFileOperations?: boolean; groupCommands?: boolean } = {}
): ProcessEntryGroup<T>[] {
  const groups: ProcessEntryGroup<T>[] = [];
  let commands: T[] = [];
  let files: T[] = [];
  const flushCommands = () => {
    if (commands.length === 0) return;
    groups.push({ kind: "commands", entries: commands });
    commands = [];
  };
  const flushFiles = () => {
    if (files.length === 0) return;
    groups.push({ kind: "files", entries: files });
    files = [];
  };
  for (const entry of entries) {
    if (isCommandProcessEntry(entry) && options.groupCommands !== false) {
      flushFiles();
      commands.push(entry);
    } else if (options.groupFileOperations && isFileOperationProcessEntry(entry)) {
      flushCommands();
      if (files.length > 0 && files[0].toolKind !== entry.toolKind) flushFiles();
      files.push(entry);
    }
    else {
      flushCommands();
      flushFiles();
      groups.push({ kind: "entry", entry });
    }
  }
  flushCommands();
  flushFiles();
  return groups;
}

export const getProcessGroupState = (entries: ProcessEntryView[]) =>
  entries.some((entry) => entry.state === "running")
    ? "running"
    : entries.some((entry) => entry.state === "error")
      ? "error"
      : entries.some((entry) => entry.state === "interrupted")
        ? "interrupted"
        : entries.some((entry) => entry.state === "warning")
          ? "warning"
          : "completed";

export const isProcessInterrupted = (entries: ProcessEntryView[]) =>
  entries.some((entry) => entry.state === "interrupted");
