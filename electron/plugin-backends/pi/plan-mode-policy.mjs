const COMMON_READ_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "find", "fd", "ls", "dir", "pwd",
  "wc", "sort", "uniq", "diff", "file", "stat", "tree", "which", "where",
  "whereis", "type", "echo", "printf", "jq", "bat", "uname", "whoami", "id",
]);

const POWERSHELL_READ_ONLY_COMMANDS = new Set([
  "get-content", "get-childitem", "get-item", "get-location", "get-command",
  "select-string", "measure-object", "compare-object", "resolve-path", "test-path",
  "format-list", "format-table", "out-string", "write-output",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "grep", "ls-files", "rev-parse", "blame",
  "describe", "merge-base", "ls-tree", "cat-file",
]);

const FORBIDDEN_ARGUMENTS = new Set([
  "-i", "--in-place", "--fix", "--write", "-delete", "--delete", "-exec",
  "-execdir", "-ok", "-okdir", "--output",
]);

const normalizeExecutable = (value) => String(value || "")
  .replace(/^.*[\\/]/, "")
  .replace(/\.(?:exe|cmd|bat)$/i, "")
  .toLowerCase();

const splitCommand = (command) => {
  const source = String(command || "").trim();
  if (!source || /[\r\n`]/.test(source)) return undefined;
  const segments = [];
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "$" && quote === '"') return undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if ([">", "<", "`", "(", ")", "{", "}"].includes(character) || character === "$") {
      return undefined;
    }
    const next = source[index + 1];
    if (character === "&" && next !== "&") return undefined;
    const separatorLength = character === ";" || character === "|"
      ? (next === character ? 2 : 1)
      : character === "&" && next === "&"
        ? 2
        : 0;
    if (!separatorLength) continue;
    const segment = source.slice(start, index).trim();
    if (!segment) return undefined;
    segments.push(segment);
    index += separatorLength - 1;
    start = index + 1;
  }
  if (quote || escaped) return undefined;
  const last = source.slice(start).trim();
  if (!last) return undefined;
  segments.push(last);
  return segments;
};

const tokenize = (segment) => {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else token += character;
  }
  if (quote || escaped) return undefined;
  if (token) tokens.push(token);
  return tokens;
};

const hasUnsafeArguments = (command, args) => {
  const normalizedArgs = args.map((argument) => argument.toLowerCase());
  if (normalizedArgs.some((argument) => FORBIDDEN_ARGUMENTS.has(argument))) return true;
  if (command === "find" && normalizedArgs.some((argument) =>
    ["-fprint", "-fprint0", "-fprintf", "-fls"].includes(argument))) return true;
  if (command === "rg" && normalizedArgs.some((argument) =>
    argument === "--pre" || argument.startsWith("--pre="))) return true;
  if (command === "bat" && normalizedArgs.some((argument) =>
    argument === "--pager" || argument.startsWith("--pager="))) return true;
  if (command === "sort" && normalizedArgs.some((argument) =>
    argument === "-o" || argument === "-t" || argument.startsWith("--output") ||
    argument.startsWith("--temporary-directory") ||
    argument.startsWith("--compress-program"))) return true;
  return false;
};

const isSafeGit = (args) => {
  let index = 0;
  while (args[index] === "--no-pager") index += 1;
  const subcommand = String(args[index] || "").toLowerCase();
  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
  return !args.slice(index + 1).some((argument) => {
    const value = argument.toLowerCase();
    return value === "--help" || value === "--paginate" || value === "--ext-diff" ||
      value === "--textconv" || value === "--output" || value.startsWith("--output=") ||
      value.includes("%g");
  });
};

const isSafeSegment = (segment, shellFamily) => {
  if (/(^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=/.test(segment)) return false;
  const tokens = tokenize(segment);
  if (!tokens?.length) return false;
  const command = normalizeExecutable(tokens[0]);
  const args = tokens.slice(1);
  if (command === "git") return isSafeGit(args);
  if (hasUnsafeArguments(command, args)) return false;
  if (COMMON_READ_ONLY_COMMANDS.has(command)) return true;
  if (shellFamily === "powershell" && POWERSHELL_READ_ONLY_COMMANDS.has(command)) return true;
  return false;
};

export const findBlockedPlanCommand = (command, shellFamily = "unknown") => {
  const segments = splitCommand(command);
  if (!segments?.length) return String(command || "").trim() || "(empty command)";
  return segments.find((segment) => !isSafeSegment(segment, shellFamily));
};

export const isPlanCommandReadOnly = (command, shellFamily = "unknown") =>
  findBlockedPlanCommand(command, shellFamily) === undefined;
