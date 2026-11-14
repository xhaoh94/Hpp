/** 会话交接摘要：把一次会话压成「换模型 / 换 agent 继续干」所需的最小上下文。 */

export type HandoffMessage = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  uiGenerated?: unknown;
  diffs?: Array<{ file?: unknown; status?: unknown }>;
};

export interface SessionHandoffInput {
  title: string;
  projectName?: string;
  agentName?: string;
  messages: HandoffMessage[];
  createdAt?: number;
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

/** 真实发言（排除问卷/UI 应答），与「发言记录」的判定保持一致。 */
const isSpeech = (message: HandoffMessage) =>
  text(message.role) === "user" && message.uiGenerated !== true && !!text(message.content).trim();

export function buildSessionHandoff(input: SessionHandoffInput): string {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const speeches = messages.filter(isSpeech);
  const goal = speeches.length > 0 ? clip(text(speeches[0].content), MAX_GOAL_CHARS) : "";

  const recent = speeches.slice(-MAX_RECENT_TURNS).map((message) => `- ${clip(text(message.content), MAX_TURN_CHARS)}`);

  const files = new Map<string, string>();
  for (const message of messages) {
    for (const diff of Array.isArray(message.diffs) ? message.diffs : []) {
      const file = text(diff.file).trim();
      if (!file) continue;
      const status = text(diff.status) === "added" ? "新增" : text(diff.status) === "deleted" ? "删除" : "修改";
      files.set(file, status);
      if (files.size >= MAX_FILES) break;
    }
    if (files.size >= MAX_FILES) break;
  }

  const lastAssistant = [...messages].reverse().find((message) =>
    text(message.role) === "assistant" && !!text(message.content).trim());
  const conclusion = lastAssistant ? clip(text(lastAssistant.content), MAX_CONCLUSION_CHARS) : "";

  const lines: string[] = [`# 会话交接：${input.title.trim() || "未命名会话"}`, ""];
  if (input.projectName?.trim()) lines.push(`- 项目：${input.projectName.trim()}`);
  if (input.agentName?.trim()) lines.push(`- 原 Agent：${input.agentName.trim()}`);
  lines.push(`- 消息数：${messages.length}`, "", "## 目标", "", goal || "（没有可用的用户发言）", "");

  if (recent.length > 1) {
    lines.push("## 最近进展", "", ...recent, "");
  }

  if (files.size > 0) {
    lines.push("## 涉及文件", "");
    for (const [file, status] of files) lines.push(`- ${file}（${status}）`);
    lines.push("");
  }

  if (conclusion) {
    lines.push("## 当前结论", "", conclusion, "");
  }

  lines.push("---", "", "以上是上一个会话的交接内容。请在此基础上继续，不要重复已完成的工作。");
  return `${lines.join("\n").trimEnd()}\n`;
}
