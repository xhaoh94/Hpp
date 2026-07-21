import { ClaudeSDKAgent, type ClaudeBackendContext } from "./backend";

export const createBackend = (
  sessionId: string,
  emit: (event: Record<string, unknown>) => void,
  context?: ClaudeBackendContext,
) => new ClaudeSDKAgent(sessionId, emit, context);
