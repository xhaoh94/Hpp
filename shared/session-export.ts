/** 会话搜索与导出的纯函数（主进程与渲染层共用）。 */

export interface SessionSearchHit {
  sessionId: string;
  messageId: string;
  sequence: number;
  role: string;
  snippet: string;
  timestamp: number;
}

export interface SessionExportRequest {
  sessionId: string;
  title: string;
  projectName?: string;
  agentName?: string;
}

export interface SessionExportResult {
  ok: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export type ExportableMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  systemType?: unknown;
};

const asText = (value: unknown) => typeof value === "string" ? value : "";

const formatTime = (value: unknown) => {
  const timestamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const ROLE_LABELS: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  system: "系统",
};

/** 搜索结果里展示的一小段上下文：命中位置前后各留一段，两端截断加省略号。 */
export function buildSearchSnippet(content: string, query: string, radius = 36): string {
  const text = content.replace(/\s+/g, " ").trim();
  const needle = query.trim().toLowerCase();
  if (!needle) return text.slice(0, radius * 2);
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export interface SessionExportInput {
  title: string;
  projectName?: string;
  agentName?: string;
  exportedAt?: number;
  messages: ExportableMessage[];
}

/** 会话导出为 Markdown：只保留角色、时间与正文，工具调用细节不进导出文件。 */
export function buildSessionMarkdown(input: SessionExportInput): string {
  const title = input.title.trim() || "会话";
  const lines: string[] = [`# ${title}`, ""];
  if (input.projectName?.trim()) lines.push(`- 项目：${input.projectName.trim()}`);
  if (input.agentName?.trim()) lines.push(`- Agent：${input.agentName.trim()}`);
  lines.push(`- 导出时间：${formatTime(input.exportedAt ?? Date.now())}`);
  lines.push(`- 消息数：${input.messages.length}`, "", "---", "");

  for (const message of input.messages) {
    const role = asText(message.role) || "assistant";
    const content = asText(message.content).trim();
    if (!content) continue;
    const time = formatTime(message.timestamp);
    const label = ROLE_LABELS[role] || role;
    lines.push(`## ${label}${time ? ` · ${time}` : ""}`, "", content, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** 导出文件名：去掉路径分隔符与 Windows 保留字符，空标题回退到会话。 */
export function sanitizeExportFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "会话";
}
