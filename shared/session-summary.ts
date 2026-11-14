/** 会话摘要的统一数据模型与 Markdown 渲染。 */

export type SummaryMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  uiGenerated?: unknown;
  diffs?: Array<{
    file?: unknown;
    status?: unknown;
    additions?: unknown;
    deletions?: unknown;
  }>;
};

export interface SessionSummaryInput {
  title: string;
  projectName?: string;
  agentName?: string;
  messages: SummaryMessage[];
  sourceSessionId?: string;
  updatedAt?: string;
}

export interface SessionSummaryFile {
  path: string;
  status: "新增" | "删除" | "修改";
  additions?: number;
  deletions?: number;
}

export interface SessionSummary {
  title: string;
  projectName?: string;
  agentName?: string;
  messageCount: number;
  updatedAt: string;
  sourceSessionId?: string;
  goal: string;
  recentProgress: string[];
  files: SessionSummaryFile[];
  conclusion: string;
}

const MAX_GOAL_CHARS = 400;
const MAX_RECENT_TURNS = 6;
const MAX_TURN_CHARS = 160;
const MAX_CONCLUSION_CHARS = 900;
const MAX_FILES = 20;

const text = (value: unknown) => typeof value === "string" ? value : "";

const clip = (value: string, limit: number) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

const finiteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** 真实发言（排除问卷/UI 应答）。 */
const isSpeech = (message: SummaryMessage) =>
  text(message.role) === "user" && message.uiGenerated !== true && !!text(message.content).trim();

const latestMessageTime = (messages: SummaryMessage[]) => {
  const latest = messages.reduce((value, message) => Math.max(value, Number(message.timestamp) || 0), 0);
  return latest > 0 ? new Date(latest).toISOString() : "";
};

export function buildSessionSummary(input: SessionSummaryInput): SessionSummary {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const speeches = messages.filter(isSpeech);
  const goal = speeches.length > 0 ? clip(text(speeches[0].content), MAX_GOAL_CHARS) : "";
  const recentProgress = speeches.slice(-MAX_RECENT_TURNS)
    .map((message) => clip(text(message.content), MAX_TURN_CHARS));

  const files = new Map<string, SessionSummaryFile>();
  for (const message of messages) {
    for (const diff of Array.isArray(message.diffs) ? message.diffs : []) {
      const file = text(diff.file).trim();
      if (!file) continue;
      files.set(file, {
        path: file,
        status: text(diff.status) === "added" ? "新增" : text(diff.status) === "deleted" ? "删除" : "修改",
        ...(finiteNumber(diff.additions) !== undefined ? { additions: finiteNumber(diff.additions) } : {}),
        ...(finiteNumber(diff.deletions) !== undefined ? { deletions: finiteNumber(diff.deletions) } : {}),
      });
    }
  }

  const lastAssistant = [...messages].reverse().find((message) =>
    text(message.role) === "assistant" && !!text(message.content).trim());
  const conclusion = lastAssistant ? clip(text(lastAssistant.content), MAX_CONCLUSION_CHARS) : "";

  return {
    title: input.title.trim() || "未命名会话",
    ...(input.projectName?.trim() ? { projectName: input.projectName.trim() } : {}),
    ...(input.agentName?.trim() ? { agentName: input.agentName.trim() } : {}),
    messageCount: messages.length,
    updatedAt: input.updatedAt?.trim() || latestMessageTime(messages) || new Date().toISOString(),
    ...(input.sourceSessionId?.trim() ? { sourceSessionId: input.sourceSessionId.trim() } : {}),
    goal,
    recentProgress,
    files: [...files.values()].slice(-MAX_FILES),
    conclusion,
  };
}

/** 引用和交接共用的摘要正文；引用模式会在外面再包一层来源信息。 */
export function renderSessionSummaryBody(summary: SessionSummary): string {
  const lines: string[] = [];
  if (summary.projectName) lines.push(`- 项目：${summary.projectName}`);
  if (summary.agentName) lines.push(`- 原 Agent：${summary.agentName}`);
  lines.push(`- 消息数：${summary.messageCount}`, `- 更新时间：${summary.updatedAt}`, "");
  lines.push("## 目标", "", summary.goal || "（没有可用的用户发言）", "");

  if (summary.recentProgress.length > 1) {
    lines.push("## 最近进展", "", ...summary.recentProgress.map((item) => `- ${item}`), "");
  }

  if (summary.files.length > 0) {
    lines.push("## 涉及文件", "");
    for (const file of summary.files) {
      const changes = file.additions !== undefined || file.deletions !== undefined
        ? `，+${file.additions ?? 0} -${file.deletions ?? 0}`
        : "";
      lines.push(`- ${file.path}（${file.status}${changes}）`);
    }
    lines.push("");
  }

  if (summary.conclusion) {
    lines.push("## 当前结论", "", summary.conclusion, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** 交接导出：纯 Markdown，可直接复制到其他 App。 */
export function renderSessionHandoff(summary: SessionSummary): string {
  return renderSessionHandoffFromBody(summary.title, renderSessionSummaryBody(summary));
}

/** 已有引用摘要正文时，生成与交接导出完全一致的文本。 */
export function renderSessionHandoffFromBody(title: string, body: string): string {
  const heading = `# 会话交接：${title.trim() || "未命名会话"}`;
  return `${heading}\n\n${body.trimEnd()}\n\n---\n\n以上是上一个会话的交接内容。请在此基础上继续，不要重复已完成的工作。\n`;
}
