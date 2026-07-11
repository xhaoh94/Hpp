import { OpenCodeAgent } from "./backend";

export const createBackend = (sessionId: string, emit: (event: Record<string, unknown>) => void) =>
  new OpenCodeAgent(sessionId, emit);
