const normalizeShellPath = (value) => String(value || "").trim().replace(/\\/g, "/").toLowerCase();

export const detectShellFamily = (shellPath) => {
  const normalized = normalizeShellPath(shellPath);
  const executable = normalized.split("/").pop() || "";
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) return "powershell";
  if (/^cmd(?:\.exe)?$/.test(executable)) return "cmd";
  if (/^(?:bash|git-bash)(?:\.exe)?$/.test(executable)) return "bash";
  if (/^(?:sh|dash|zsh|fish)(?:\.exe)?$/.test(executable)) return "posix";
  return "unknown";
};

const displayPlatform = (platform) => {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform || "unknown";
};

const shellSyntaxName = (family) => {
  if (family === "bash" || family === "posix") return "POSIX shell";
  if (family === "powershell") return "PowerShell";
  if (family === "cmd") return "Command Prompt";
  return "the configured shell";
};

export const POWERSHELL_UTF8_COMMAND_PREFIX = [
  "$__hppUtf8 = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::InputEncoding = $__hppUtf8",
  "[Console]::OutputEncoding = $__hppUtf8",
  "$OutputEncoding = $__hppUtf8",
  "chcp.com 65001 > $null",
].join("; ");

export const rewritePowerShellPackageManagerCommand = (command) => String(command || "").replace(
  /((?:^|\r?\n|[;&|{(])\s*)(npm|npx|pnpm|yarn)(?=\s|$)/gi,
  (_match, prefix, executable) => `${prefix}${executable}.cmd`,
);

export const buildShellEnvironmentContract = ({ platform, cwd, shellPath, shellFamily, shellAvailable = true }) => {
  const facts = [
    "Hpp runtime environment contract (follow this instead of guessing or probing the shell):",
    `- Operating system: ${displayPlatform(platform)} (${platform || "unknown"}).`,
    `- Working directory: ${cwd || "unknown"}.`,
    `- The Pi tool named bash actually executes: ${shellPath || "the Pi-configured shell"}.`,
    `- Required command syntax: ${shellSyntaxName(shellFamily)}.`,
    "- Prefer project-relative paths and dedicated read/write/edit/discovery tools for file operations.",
    "- Do not try equivalent commands from different shells to discover which one works.",
  ];

  if (shellAvailable) {
    facts.push(
      "- The tool whose schema name is bash is registered and available in this request. Call that tool directly when command execution is needed; never claim that no shell/exec tool exists while bash appears in the provided tool schema.",
    );
  } else {
    facts.push("- Command execution is unavailable because the configured shell failed Hpp's startup probe; use the dedicated discovery and file tools instead.");
  }

  if (platform === "win32" && (shellFamily === "bash" || shellFamily === "posix")) {
    facts.push(
      "- This is a POSIX shell on Windows: use commands such as rm, cp, mv, ls, find, and grep; do not use cmd built-ins such as del, copy, move, or ren, and do not use PowerShell cmdlets directly.",
      "- Never pass a raw Windows path such as C:\\work\\file to the bash tool. Prefer a relative path; when an absolute path is unavoidable, convert it to POSIX form such as /c/work/file.",
    );
  } else if (shellFamily === "powershell") {
    facts.push(
      "- Use PowerShell syntax and quote Windows paths; do not assume Bash-only syntax is available.",
      "- On Windows PowerShell, invoke Node package-manager shims as npm.cmd, npx.cmd, pnpm.cmd, and yarn.cmd so PowerShell execution policy cannot select and block the corresponding .ps1 shim. Hpp also normalizes bare package-manager commands at execution time.",
    );
  } else if (shellFamily === "cmd") {
    facts.push("- Use cmd.exe syntax; do not assume Bash or PowerShell commands are available.");
  } else if (shellFamily === "bash" || shellFamily === "posix") {
    facts.push("- Use POSIX commands and POSIX path syntax; do not use Windows cmd or PowerShell commands.");
  }

  return facts.join("\n");
};

const splitCommandSegments = (command) => String(command || "")
  .split(/(?:&&|\|\||[;\n])/)
  .map((segment) => segment.trim())
  .filter(Boolean);

const explicitlyInvokesWindowsShell = (command) => splitCommandSegments(command).some((segment) =>
  /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?)\b/i.test(segment));

const findMismatchedPosixSegment = (command) => splitCommandSegments(command).find((segment) =>
  /^(?:del|erase|copy|move|ren|cls)\b/i.test(segment) ||
  /^(?:Remove-Item|Copy-Item|Move-Item|Rename-Item|Get-ChildItem|Test-Path|Set-Location)\b/i.test(segment));

const findMismatchedCmdSegment = (command) => splitCommandSegments(command).find((segment) =>
  /^(?:rm|cp|mv|ls|pwd|grep|sed|awk|cat|chmod|chown)\b/.test(segment));

export const validateShellCommand = ({ platform, shellFamily, command }) => {
  const text = String(command || "").trim();
  if (!text) return null;

  if (shellFamily === "bash" || shellFamily === "posix") {
    const mismatched = findMismatchedPosixSegment(text);
    if (mismatched && !explicitlyInvokesWindowsShell(text)) {
      return `Hpp 环境预检已阻止该命令：当前工具使用 POSIX Shell，但命令片段“${mismatched}”属于 Windows cmd 或 PowerShell。请直接使用对应的 POSIX 命令，并优先使用项目相对路径。`;
    }
    if (platform === "win32" && !explicitlyInvokesWindowsShell(text) && /(?:^|[\s='"(])[a-zA-Z]:\\/.test(text)) {
      return "Hpp 环境预检已阻止该命令：Windows 上的 Bash 不能直接使用 C:\\... 形式的路径。请优先使用项目相对路径，或转换为 /c/... 形式。";
    }
  }

  if (shellFamily === "cmd") {
    const mismatched = findMismatchedCmdSegment(text);
    if (mismatched) {
      return `Hpp 环境预检已阻止该命令：当前工具使用 cmd.exe，但命令片段“${mismatched}”使用了 POSIX 命令。请改用 cmd.exe 语法。`;
    }
  }

  return null;
};
