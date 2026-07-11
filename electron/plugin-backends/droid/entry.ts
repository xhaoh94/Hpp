import { DroidAgent } from "./backend";

export const createBackend = (sessionId: string, emit: (event: Record<string, unknown>) => void) =>
  new DroidAgent(sessionId, emit);
