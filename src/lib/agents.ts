// All available agents in the application
export const AVAILABLE_AGENTS = [
  { id: "pi", name: "Pi Agent", desc: "AI 编程助手", runtime: "sdk" },
  { id: "opencode", name: "OpenCode", desc: "开源 AI 编程助手", runtime: "cli", command: "opencode" },
  { id: "droid", name: "Factory Droid", desc: "Factory AI 编程助手", runtime: "cli", command: "droid" },
];

export function getAgentName(id: string): string {
  return AVAILABLE_AGENTS.find((a) => a.id === id)?.name || id;
}

export function getInstallHint(command: string): string {
  switch (command) {
    case "pi": return "在通用设置中更新 Pi SDK，或运行 npm install @earendil-works/pi-coding-agent@latest";
    case "opencode": return "npm install -g opencode-ai";
    case "droid": return "npm install -g droid";
    default: return `请安装 ${command}`;
  }
}

export function getAgentUpdateCommand(agentId: string): string | null {
  switch (agentId) {
    case "pi": return "npm install @earendil-works/pi-coding-agent@latest";
    case "opencode": return "npm install -g opencode-ai@latest";
    case "droid": return "npm install -g droid@latest";
    default: return null;
  }
}
