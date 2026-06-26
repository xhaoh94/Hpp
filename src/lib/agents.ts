// All available agents in the application
export const AVAILABLE_AGENTS = [
  { id: "pi", name: "Pi Agent", desc: "AI 编程助手", command: "pi" },
  { id: "opencode", name: "OpenCode", desc: "开源 AI 编程助手", command: "opencode" },
  { id: "droid", name: "Factory Droid", desc: "Factory AI 编程助手", command: "droid" },
];

export function getAgentName(id: string): string {
  return AVAILABLE_AGENTS.find((a) => a.id === id)?.name || id;
}

export function getInstallHint(command: string): string {
  switch (command) {
    case "pi": return "npm install -g @anthropic-ai/pi";
    case "opencode": return "npm install -g opencode-ai";
    case "droid": return "curl -fsSL https://app.factory.ai/cli | sh";
    default: return `请安装 ${command}`;
  }
}
