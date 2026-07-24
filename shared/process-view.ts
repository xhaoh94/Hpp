export type ProcessEntryView = {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking" | "question" | "subagent";
  kind?: "assistant_narration";
  title: string;
  toolKind?: string;
  detail?: string;
  command?: string;
  exitCode?: number;
  state?: "running" | "completed" | "warning" | "error" | "interrupted";
  files?: unknown[];
};

export type ProcessEntryGroup<T extends ProcessEntryView> =
  | { kind: "entry"; entry: T }
  | { kind: "commands"; entries: T[] };

export const isCommandProcessEntry = (entry: ProcessEntryView) =>
  entry.toolKind === "run_command" || (
    entry.type === "tool" && /^(?:已运行|正在运行)\s+/.test(entry.title)
  );

export const ASSISTANT_NARRATION_PROCESS_KIND = "assistant_narration" as const;

export const isAssistantNarrationProcessEntry = (entry: ProcessEntryView) =>
  entry.kind === ASSISTANT_NARRATION_PROCESS_KIND;

export function getVisibleProcessEntries<T extends ProcessEntryView>(entries: T[]) {
  return entries.filter((entry) =>
    !isAssistantNarrationProcessEntry(entry) || Boolean(entry.detail?.trim())
  );
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

export function groupProcessEntries<T extends ProcessEntryView>(entries: T[]): ProcessEntryGroup<T>[] {
  const groups: ProcessEntryGroup<T>[] = [];
  let commands: T[] = [];
  const flushCommands = () => {
    if (commands.length === 0) return;
    groups.push({ kind: "commands", entries: commands });
    commands = [];
  };
  for (const entry of entries) {
    if (isCommandProcessEntry(entry)) commands.push(entry);
    else {
      flushCommands();
      groups.push({ kind: "entry", entry });
    }
  }
  flushCommands();
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
