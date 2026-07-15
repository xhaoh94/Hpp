const isWindowsShellShim = (filePath, platform) =>
  platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);

const quoteWindowsArgument = (value) => {
  const text = String(value);
  if (!text || /[\s"&|<>^()]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

export const getCodexCommandInvocation = (
  command,
  args,
  platform = process.platform,
  env = process.env,
) => {
  if (!isWindowsShellShim(command, platform)) return { command, args };
  const commandLine = [quoteWindowsArgument(command), ...args.map(quoteWindowsArgument)].join(" ");
  return {
    command: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `call ${commandLine}`],
  };
};
