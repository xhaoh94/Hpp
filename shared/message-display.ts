export type DisplayMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  isStreaming?: boolean;
  images?: unknown[];
  sessionReferences?: unknown[];
  diffs?: unknown[];
  process?: { endedAt?: number };
};

export function formatHistoryMessageTime(timestamp: number, now = new Date()) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${time}`;
}

export const areAssistantMessageActionsVisible = (message: DisplayMessage) =>
  message.role === "assistant" &&
  message.content.trim().length > 0 &&
  message.isStreaming !== true &&
  (!message.process || message.process.endedAt !== undefined);

export const hasVisibleMessageContent = (message: DisplayMessage) =>
  message.content.trim().length > 0 ||
  !!message.images?.length ||
  !!message.sessionReferences?.length ||
  !!message.diffs?.length;
