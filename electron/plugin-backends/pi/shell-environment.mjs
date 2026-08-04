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
  if (family === "bash" || family === "posix") return "POSIX Shell";
  if (family === "powershell") return "PowerShell";
  if (family === "cmd") return "cmd.exe 命令提示符";
  return "配置的 Shell";
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
    "Hpp 运行环境契约（请遵循以下事实，不要猜测或反复探测 Shell）：",
    `- 操作系统：${displayPlatform(platform)}（${platform || "unknown"}）。`,
    `- 工作目录：${cwd || "unknown"}。`,
    `- 名为 bash 的 Pi 工具实际执行：${shellPath || "Pi 配置的 Shell"}。`,
    `- 必须使用的命令语法：${shellSyntaxName(shellFamily)}。`,
    "- 文件操作优先使用项目相对路径，以及专用的 read/write/edit/文件发现工具。",
    "- 不要通过尝试不同 Shell 的等价命令来猜测哪个可用。",
  ];

  if (shellAvailable) {
    facts.push(
      "- 工具架构中名为 bash 的工具已注册并可在本回合使用。需要执行命令时请直接调用它；只要工具架构中存在 bash，就不要声称没有 Shell 或 exec 工具。",
    );
  } else {
    facts.push("- 由于配置的 Shell 未通过 Hpp 启动预检，当前无法执行命令；请改用专用的文件发现和文件操作工具。");
  }

  if (platform === "win32" && (shellFamily === "bash" || shellFamily === "posix")) {
    facts.push(
      "- 当前是 Windows 上的 POSIX Shell：使用 rm、cp、mv、ls、find 和 grep 等命令；不要使用 del、copy、move、ren 等 cmd 内置命令，也不要直接使用 PowerShell cmdlet。",
      "- 不要将 C:\\work\\file 这样的原始 Windows 路径传给 bash 工具。优先使用相对路径；必须使用绝对路径时，转换为 /c/work/file 这样的 POSIX 格式。",
    );
  } else if (shellFamily === "powershell") {
    facts.push(
      "- 使用 PowerShell 语法并为 Windows 路径加引号；不要假设 Bash 专属语法可用。",
      "- 在 Windows PowerShell 中，请使用 npm.cmd、npx.cmd、pnpm.cmd 和 yarn.cmd 调用 Node 包管理器 shim，避免 PowerShell 执行策略选择并阻止对应的 .ps1 shim。Hpp 也会在执行时规范化未带扩展名的包管理器命令。",
    );
  } else if (shellFamily === "cmd") {
    facts.push("- 使用 cmd.exe 语法；不要假设 Bash 或 PowerShell 命令可用。");
  } else if (shellFamily === "bash" || shellFamily === "posix") {
    facts.push("- 使用 POSIX 命令和 POSIX 路径语法；不要使用 Windows cmd 或 PowerShell 命令。");
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
