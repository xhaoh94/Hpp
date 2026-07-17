export type ProcessEntryView = {
  id: string;
  type: "status" | "tool" | "diff" | "error" | "info" | "thinking" | "question";
  title: string;
  toolKind?: string;
  detail?: string;
  command?: string;
  state?: "running" | "completed" | "error" | "interrupted";
  files?: unknown[];
};

export type ProcessEntryGroup<T extends ProcessEntryView> =
  | { kind: "entry"; entry: T }
  | { kind: "commands"; entries: T[] };

export const isCommandProcessEntry = (entry: ProcessEntryView) =>
  entry.toolKind === "run_command" || (
    entry.type === "tool" && /^(?:已运行|正在运行)\s+/.test(entry.title)
  );

export const isBodyOutputProcessEntry = (entry: ProcessEntryView) =>
  entry.type === "info" && entry.title.trim() === "正文输出";

export function getVisibleProcessEntries<T extends ProcessEntryView>(entries: T[]) {
  return entries.filter((entry) => !isBodyOutputProcessEntry(entry));
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
        : "completed";

export const isProcessInterrupted = (entries: ProcessEntryView[]) =>
  entries.some((entry) => entry.state === "interrupted");
