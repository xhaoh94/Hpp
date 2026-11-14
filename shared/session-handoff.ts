/** 会话交接摘要：把一次会话压成「换模型 / 换 agent 继续干」所需的最小上下文。 */

import {
  buildSessionSummary,
  renderSessionHandoff,
  type SessionSummaryInput,
  type SummaryMessage,
} from "./session-summary";

export type HandoffMessage = SummaryMessage;
export type SessionHandoffInput = SessionSummaryInput;

export function buildSessionHandoff(input: SessionHandoffInput): string {
  return renderSessionHandoff(buildSessionSummary(input));
}
