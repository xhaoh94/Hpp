import { CodebuddyAgent, type CodebuddyBackendContext } from "./backend";

export const createBackend = (
  sessionId: string,
  emit: (event: Record<string, unknown>) => void,
  context?: CodebuddyBackendContext,
) => new CodebuddyAgent(sessionId, emit, context);