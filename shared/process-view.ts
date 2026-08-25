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
  exitCode?: number;
  state?: "running" | "completed" | "warning" | "error" | "interrupted";
  files?: unknown[];
  timestamp?: number;
  startedAt?: number;
  completedAt?: number;
  phase?: "started" | "completed";
  stopReason?: ProcessSubagentStopReason;
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
  }>;
};

export type ProcessPlanStepView = {
  status: string;
};

export type ProcessView<
  TEntry extends ProcessEntryView = ProcessEntryView,
  TStep extends ProcessPlanStepView = ProcessPlanStepView,
> = {
  startedAt: number;
  endedAt?: number;
  entries: TEntry[];
  planSteps?: TStep[];
};

export type ProcessTerminalViewState = "completed" | "error" | "interrupted";

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

export const isAssistantNarrationProcessEntry = (entry: ProcessEntryView) =>
  entry.kind === ASSISTANT_NARRATION_PROCESS_KIND;

export const isUserGuidanceProcessEntry = (entry: ProcessEntryView) =>
  entry.kind === USER_GUIDANCE_PROCESS_KIND ||
  entry.toolKind === "guidance_message" ||
  entry.toolKind === "guidance" ||
  /^收到引导(?:[:：]|$)/.test(entry.title);

export const getUserGuidanceText = (entry: ProcessEntryView) => {
  const isLegacyEntry = /^收到引导(?:[:：]|$)/.test(entry.title);
  if (isLegacyEntry) {
    const legacyTitle = entry.title
      .replace(/^收到引导\s*[:：]?\s*/, "")
      .replace(/^["“](.*)["”]$/, "$1")
      .trim();
    return legacyTitle || entry.detail || "";
  }
  if (entry.detail?.trim()) return entry.detail;
  return entry.title === "引导" ? "" : entry.title;
};

export function getVisibleProcessEntries<T extends ProcessEntryView>(entries: T[]) {
  return entries.filter((entry) => {
    // `message_received` used to duplicate the user's bubble inside the
    // process timeline. Keep persisted records intact, but never display the
    // redundant row on either desktop or mobile clients.
    if (entry.toolKind === "message_received" || /^收到消息(?:[:：]|$)/.test(entry.title)) {
      return false;
    }
    return !isAssistantNarrationProcessEntry(entry) || Boolean(entry.detail?.trim());
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
  options: { groupFileOperations?: boolean } = {}
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
    if (isCommandProcessEntry(entry)) {
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
