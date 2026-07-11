import { PiSDKAgent } from "./backend";

export const createBackend = (sessionId: string, emit: (event: Record<string, unknown>) => void) =>
  new PiSDKAgent(sessionId, emit);
