export type NormalizedToolKind =
  | "read_file"
  | "list_dir"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "search_files"
  | "search_text"
  | "web_fetch"
  | "web_search"
  | "question"
  | "unknown";

export interface NormalizedProcessFile {
  file: string;
  label?: string;
  action?: "read" | "listed" | "edited" | "modified" | "written";
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
}

export interface NormalizedToolPayload {
  type: "tool_start" | "tool_end";
  toolName: string;
  toolCallId?: string;
  toolKind: NormalizedToolKind;
  requestId?: string;
  method?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  detail?: string;
  outputText?: string;
  errorText?: string;
  files?: NormalizedProcessFile[];
  filePath?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  command?: string;
  pattern?: string;
  question?: unknown;
  prompt?: unknown;
  message?: unknown;
  questions?: unknown;
  options?: unknown;
}

export interface NormalizedFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

const normalizeEventToken = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s._:-]+/g, "");

export const isContextCompactionLike = (...values: unknown[]) => {
  const normalized = values.map(normalizeEventToken).filter(Boolean);
  return normalized.some((value) =>
    value.includes("contextcompaction") ||
    value.includes("compactedcontext") ||
    value.includes("compactcontext") ||
    value.includes("contextcompact") ||
    value.includes("contextsummary") ||
    value.includes("summarizecontext") ||
    value.includes("contextsummarized") ||
    value.includes("conversationcompaction") ||
    value.includes("conversationcompacted") ||
    value.includes("conversationcompact") ||
    value.includes("memorycompaction") ||
    value.includes("压缩上下文") ||
    value.includes("上下文压缩") ||
    value.includes("上下文已自动压缩")
  );
};

const TOOL_KIND_ALIASES: Record<Exclude<NormalizedToolKind, "unknown">, string[]> = {
  read_file: ["read", "readfile", "read_file", "view", "view_file", "open_file"],
  list_dir: [
    "list",
    "list_dir",
    "list_directory",
    "ls",
    "readdir",
    "read_dir",
    "read_directory",
    "readfolder",
    "read_folder",
    "tree",
    "directory_tree",
  ],
  write_file: ["write", "writefile", "write_file", "create", "create_file"],
  edit_file: [
    "edit",
    "edit_file",
    "multiedit",
    "multi_edit",
    "apply_patch",
    "patch",
    "str_replace_editor",
    "str_replace_based_edit_tool",
    "replace_in_file",
  ],
  run_command: [
    "bash",
    "shell",
    "sh",
    "powershell",
    "pwsh",
    "cmd",
    "run",
    "run_command",
    "runcommand",
    "execute",
    "exec",
    "execute-cli",
    "execute_cli",
    "execute_command",
    "executecommand",
    "terminal",
  ],
  search_files: ["glob", "find", "fd", "file_search", "search_files"],
  search_text: ["grep", "rg", "search", "search_text", "content_search"],
  web_fetch: ["webfetch", "web_fetch", "fetch", "fetch_url"],
  web_search: ["websearch", "web_search", "search_web"],
  question: [
    "question",
    "questionnaire",
    "ask",
    "ask_question",
    "ask-followup-question",
    "ask_followup_question",
    "ask-user-question",
    "ask_user",
    "ask_user_question",
    "user_ask_question",
    "request_user",
    "request_user_input",
    "request_user_selection",
    "droid.ask_user",
  ],
};

const normalizeName = (value: unknown) => String(value || "").trim().toLowerCase();

const matchesToolAlias = (normalized: string, alias: string) =>
  normalized === alias ||
  normalized.endsWith(`.${alias}`) ||
  normalized.endsWith(`/${alias}`) ||
  normalized.endsWith(`:${alias}`) ||
  normalized.endsWith(`__${alias}`);

const getNestedValue = (value: unknown, path: string[]): unknown => {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const findFirstString = (value: unknown, paths: string[][]): string => {
  for (const path of paths) {
    const found = getNestedValue(value, path);
    if (typeof found === "string" && found.trim()) return found;
  }
  return "";
};

const tryParseJson = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

export const unwrapToolText = (value: unknown, depth = 0): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const parsed = depth < 2 ? tryParseJson(value) : undefined;
    if (parsed !== undefined) {
      const parsedText = unwrapToolText(parsed, depth + 1);
      if (parsedText !== undefined) return parsedText;
    }
    return value;
  }
  if (typeof value !== "object") return undefined;

  const record = asRecord(value);
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item;
        const itemRecord = asRecord(item);
        if (itemRecord.type === "text" && typeof itemRecord.text === "string") return itemRecord.text;
        if (typeof itemRecord.text === "string") return itemRecord.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }

  if (typeof record.text === "string" && (!record.type || record.type === "text")) {
    return record.text;
  }

  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  if (stdout || stderr) return [stdout, stderr].filter(Boolean).join("\n");

  for (const key of ["output", "result", "message"]) {
    const text = record[key];
    if (typeof text === "string") return text;
  }

  return undefined;
};

const stringifyProcessValue = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const truncateDetail = (value: string) => {
  const maxLength = 1200;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
};

const getFileName = (filePath: string) => {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
};

export const extractFilePathFromPatch = (patch: string): string => {
  const lines = patch.split("\n");
  for (const line of lines) {
    const match =
      line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/) ||
      line.match(/^diff --git\s+a\/.+\s+b\/(.+)$/) ||
      line.match(/^\+\+\+\s+(?:b\/)?(.+)$/) ||
      line.match(/^---\s+(?:a\/)?(.+)$/);
    if (!match) continue;
    const filePath = match[1].trim();
    if (filePath && filePath !== "/dev/null") return filePath;
  }
  return "";
};

const countPatchChanges = (patch: string) => ({
  additions: (patch.match(/^\+[^+]/gm) || []).length,
  deletions: (patch.match(/^-[^-]/gm) || []).length,
});

const getToolKind = (toolName: unknown, command: string, patch: string): NormalizedToolKind => {
  const normalized = normalizeName(toolName);
  for (const [kind, aliases] of Object.entries(TOOL_KIND_ALIASES) as Array<[NormalizedToolKind, string[]]>) {
    if (aliases.some((alias) => matchesToolAlias(normalized, alias))) return kind;
  }
  if (patch) return "edit_file";
  if (command && !normalized) return "run_command";
  return "unknown";
};

export const isQuestionToolName = (toolName: unknown): boolean =>
  getToolKind(toolName, "", "") === "question";

const getToolPath = (
  toolKind: NormalizedToolKind,
  data: unknown,
  args: unknown,
  result: unknown,
  patchFilePath: string
): string => {
  if (patchFilePath) return patchFilePath;
  if (!["read_file", "list_dir", "write_file", "edit_file"].includes(toolKind)) return "";

  return findFirstString(
    { args, result, data },
    [
      ["args", "filePath"],
      ["args", "file_path"],
      ["args", "path"],
      ["args", "file"],
      ["args", "filename"],
      ["args", "fileName"],
      ["args", "target_file"],
      ["args", "targetFile"],
      ["args", "directory"],
      ["args", "directory_path"],
      ["args", "directoryPath"],
      ["args", "dir"],
      ["data", "filePath"],
      ["data", "file_path"],
      ["data", "path"],
      ["data", "file"],
      ["data", "filename"],
      ["data", "fileName"],
      ["data", "directory"],
      ["data", "directory_path"],
      ["data", "directoryPath"],
      ["result", "filePath"],
      ["result", "file_path"],
      ["result", "path"],
      ["result", "file"],
      ["result", "filename"],
      ["result", "fileName"],
      ["result", "directory"],
      ["result", "directory_path"],
      ["result", "directoryPath"],
    ]
  );
};

const getPatch = (data: unknown, args: unknown, result: unknown): string => {
  const directPatch = findFirstString(
    { data, args, result },
    [
      ["result", "gitDiff", "patch"],
      ["result", "details", "patch"],
      ["result", "details", "diff"],
      ["result", "patch"],
      ["result", "diff"],
      ["args", "patch"],
      ["args", "diff"],
      ["data", "patch"],
      ["data", "diff"],
    ]
  );
  if (directPatch) return directPatch;

  const resultRecord = asRecord(result);
  const structuredPatch = Array.isArray(resultRecord.structuredPatch) ? resultRecord.structuredPatch : [];
  return structuredPatch.flatMap((rawHunk) => {
    const hunk = asRecord(rawHunk);
    if (!Array.isArray(hunk.lines)) return [];
    const oldStart = Number(hunk.oldStart || 0);
    const oldLines = Number(hunk.oldLines || 0);
    const newStart = Number(hunk.newStart || 0);
    const newLines = Number(hunk.newLines || 0);
    return [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...hunk.lines.map(String)];
  }).join("\n");
};

const getCommand = (args: unknown, data: unknown): string =>
  findFirstString(
    { args, data },
    [
      ["args", "command"],
      ["args", "cmd"],
      ["args", "script"],
      ["data", "command"],
      ["data", "cmd"],
      ["data", "script"],
    ]
  );

const getPattern = (args: unknown, data: unknown): string =>
  findFirstString(
    { args, data },
    [
      ["args", "pattern"],
      ["args", "query"],
      ["args", "glob"],
      ["data", "pattern"],
      ["data", "query"],
      ["data", "glob"],
    ]
  );

const buildFiles = (
  toolKind: NormalizedToolKind,
  filePath: string,
  patch: string,
  additions?: number,
  deletions?: number
): NormalizedProcessFile[] => {
  if (!filePath) return [];

  const action =
    toolKind === "read_file" ? "read" :
    toolKind === "list_dir" ? "listed" :
    toolKind === "write_file" ? "written" :
    toolKind === "edit_file" ? "edited" :
    undefined;

  if (!action) return [];

  return [{
    file: filePath,
    label: getFileName(filePath),
    action,
    patch: patch || undefined,
    additions,
    deletions,
    status: patch ? "modified" : undefined,
  }];
};

const getErrorText = (data: UnknownRecord) => {
  const direct = unwrapToolText(data.error);
  if (direct) return direct;
  if (typeof data.message === "string") return data.message;
  if (data.error) return stringifyProcessValue(data.error);
  return "";
};

const buildDetail = (payload: {
  phase: "tool_start" | "tool_end";
  toolKind: NormalizedToolKind;
  command: string;
  outputText?: string;
  errorText?: string;
  rawDetail?: unknown;
  isError?: boolean;
}) => {
  const lines: string[] = [];
  const detailAllowedKinds: NormalizedToolKind[] = [
    "run_command",
    "search_files",
    "search_text",
    "web_fetch",
    "web_search",
    "unknown",
  ];
  if (payload.toolKind === "run_command" && payload.command) {
    lines.push(`$ ${payload.command}`);
  }
  if (payload.isError && payload.errorText) {
    lines.push(payload.errorText);
  } else if (payload.outputText && detailAllowedKinds.includes(payload.toolKind)) {
    lines.push(payload.outputText);
  } else if (detailAllowedKinds.includes(payload.toolKind) && typeof payload.rawDetail === "string" && payload.rawDetail.trim()) {
    lines.push(payload.rawDetail);
  }
  const detail = lines.filter(Boolean).join("\n");
  return detail ? truncateDetail(detail) : undefined;
};

export const normalizeToolEvent = (
  phase: "tool_start" | "tool_end",
  data: unknown
): NormalizedToolPayload => {
  const dataRecord = asRecord(data);
  const args =
    dataRecord.args ||
    dataRecord.input ||
    dataRecord.parameters ||
    dataRecord.toolInput ||
    dataRecord.tool_input ||
    dataRecord.arguments;
  const result = dataRecord.result !== undefined ? dataRecord.result : dataRecord.output;
  const toolName = String(dataRecord.toolName || dataRecord.name || dataRecord.tool || "tool");
  const toolCallId = dataRecord.toolCallId || dataRecord.callId || dataRecord.callID || dataRecord.id;
  const patch = getPatch(data, args || {}, result || {});
  const command = getCommand(args || {}, data);
  const pattern = getPattern(args || {}, data);
  const toolKind = getToolKind(toolName, command, patch);
  const detailObject = asRecord(dataRecord.detail);
  const argsObject = asRecord(args);
  const patchFilePath = patch ? extractFilePathFromPatch(patch) : "";
  const filePath = getToolPath(toolKind, data, args || {}, result || {}, patchFilePath);
  const changes = patch ? countPatchChanges(patch) : { additions: undefined, deletions: undefined };
  const outputText = unwrapToolText(result);
  const errorText = dataRecord.isError ? getErrorText(dataRecord) : undefined;
  const files = buildFiles(toolKind, filePath, patch, changes.additions, changes.deletions);
  const detail = buildDetail({
    phase,
    toolKind,
    command,
    outputText,
    errorText,
    rawDetail: dataRecord.detail,
    isError: !!dataRecord.isError,
  });

  return {
    type: phase,
    toolName,
    toolCallId: toolCallId ? String(toolCallId) : undefined,
    toolKind,
    requestId: toolKind === "question" && toolCallId ? String(toolCallId) : undefined,
    method: toolKind === "question" ? toolName : undefined,
    args,
    result,
    isError: !!dataRecord.isError,
    detail,
    outputText,
    errorText,
    files: files.length > 0 ? files : undefined,
    filePath: filePath || undefined,
    patch: patch || undefined,
    additions: changes.additions,
    deletions: changes.deletions,
    command: command || undefined,
    pattern: pattern || undefined,
    question: dataRecord.question || detailObject.question || argsObject.question || argsObject.prompt || undefined,
    prompt: dataRecord.prompt || detailObject.prompt || argsObject.prompt || undefined,
    message: dataRecord.message || detailObject.message || argsObject.message || undefined,
    questions: dataRecord.questions || detailObject.questions || argsObject.questions || undefined,
    options: dataRecord.options || detailObject.options || argsObject.options || argsObject.choices || undefined,
  };
};

export const buildDiffsFromToolEvent = (payload: Pick<NormalizedToolPayload, "patch" | "filePath" | "additions" | "deletions">): NormalizedFileDiff[] => {
  if (!payload.patch || !payload.filePath) return [];
  return [{
    file: payload.filePath,
    patch: payload.patch,
    additions: payload.additions || 0,
    deletions: payload.deletions || 0,
    status: "modified",
  }];
};

export const normalizeQuestionProcessEvent = (data: unknown) => {
  const dataRecord = asRecord(data);
  const detailObject = asRecord(dataRecord.detail);
  const argsObject = asRecord(dataRecord.args);
  const inputObject = asRecord(dataRecord.input);
  const detailParams = asRecord(detailObject.params);
  const prompt =
    dataRecord.title ||
    dataRecord.question ||
    dataRecord.prompt ||
    dataRecord.message ||
    dataRecord.placeholder ||
    findFirstString(data, [
      ["detail", "title"],
      ["detail", "message"],
      ["detail", "question"],
      ["detail", "prompt"],
      ["args", "title"],
      ["args", "message"],
      ["args", "question"],
      ["args", "prompt"],
      ["input", "title"],
      ["input", "message"],
      ["input", "question"],
      ["input", "prompt"],
    ]);
  const questions =
    dataRecord.questions ||
    detailObject.questions ||
    detailParams.questions ||
    argsObject.questions ||
    inputObject.questions;
  const options =
    dataRecord.options ||
    detailObject.options ||
    detailObject.choices ||
    detailParams.options ||
    detailParams.choices ||
    argsObject.options ||
    argsObject.choices ||
    inputObject.options ||
    inputObject.choices;
  const detail =
    prompt ||
    unwrapToolText(dataRecord.args) ||
    unwrapToolText(dataRecord.input) ||
    (typeof dataRecord.detail === "string" ? dataRecord.detail : stringifyProcessValue(dataRecord.detail || data));

  return {
    type: "process_event",
    entryType: "question",
    kind: "question",
    requestId: dataRecord.requestId || dataRecord.id || dataRecord.toolCallId || dataRecord.callId || detailObject.id,
    method: dataRecord.method || dataRecord.toolName || dataRecord.name || dataRecord.type,
    title: prompt ? `正在询问用户: ${String(prompt)}` : "正在询问用户",
    detail,
    prompt: prompt || undefined,
    question: dataRecord.question || detailObject.question || argsObject.question || inputObject.question || undefined,
    questions,
    options,
    state: dataRecord.state || "running",
  };
};
