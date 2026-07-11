import { CodexAgent } from "./backend";

export const createBackend = (sessionId: string, emit: (event: Record<string, unknown>) => void) =>
  new CodexAgent(sessionId, emit);
