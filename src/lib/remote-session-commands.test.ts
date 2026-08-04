import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingUIResponse } from "@/components/layout/agentEventTypes";
import { SessionCommandCoordinator } from "./session-command-coordinator";
import {
  abortRemoteSession,
  executeRemoteSessionCommand,
  type RemoteCommandContext,
} from "./remote-session-commands";

const createContext = (success: boolean) => {
  const abortSession = vi.fn(async () => success);
  const clearPendingInteraction = vi.fn();
  const getPendingInteraction = vi.fn((_sessionId: string): PendingUIResponse => null);
  const context: RemoteCommandContext = {
    getPendingInteraction,
    abortSession,
    clearPendingInteraction,
  };
  return { abortSession, clearPendingInteraction, getPendingInteraction, context };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote session abort", () => {
  it("uses the shared manual-abort coordinator and clears the interaction", async () => {
    const { abortSession, clearPendingInteraction, context } = createContext(true);

    await expect(abortRemoteSession("session-1", context)).resolves.toEqual({ success: true });
    expect(abortSession).toHaveBeenCalledWith("session-1");
    expect(clearPendingInteraction).toHaveBeenCalledWith("session-1");
  });

  it("keeps the interaction when the abort coordinator reports failure", async () => {
    const { clearPendingInteraction, context } = createContext(false);

    await expect(abortRemoteSession("session-1", context)).rejects.toThrow("ABORT_FAILED");
    expect(clearPendingInteraction).not.toHaveBeenCalled();
  });
});

describe("remote interaction response", () => {
  it("reads and clears only the interaction belonging to the requested session", async () => {
    const interactionA = {
      sessionId: "A",
      requestId: "request-A",
      method: "question",
      questions: [],
    };
    const interactionB = {
      sessionId: "B",
      requestId: "request-B",
      method: "question",
      questions: [],
    };
    const interactions: Record<string, typeof interactionA> = { A: interactionA, B: interactionB };
    const clearPendingInteraction = vi.fn((sessionId: string) => {
      delete interactions[sessionId];
    });
    const getPendingInteraction = vi.fn((sessionId: string): PendingUIResponse => interactions[sessionId] || null);
    const onInteractionResponsePrepared = vi.fn();
    const onInteractionResponseAccepted = vi.fn();
    const onInteractionResponseFailed = vi.fn();
    const respondToInteraction = vi.spyOn(SessionCommandCoordinator, "respondToInteraction")
      .mockImplementation(async (input, context) => {
        expect(input.sessionId).toBe("B");
        expect(context.getPendingInteraction?.(input.sessionId)).toBe(interactionB);
        expect(context.onResponsePrepared).toBe(onInteractionResponsePrepared);
        expect(context.onResponseAccepted).toBe(onInteractionResponseAccepted);
        expect(context.onResponseFailed).toBe(onInteractionResponseFailed);
        context.clearPendingInteraction(input.sessionId);
        return { cancelled: false };
      });

    await expect(executeRemoteSessionCommand({
      commandId: "command-1",
      name: "interaction.respond",
      payload: { sessionId: "B", text: "answer B" },
    }, {
      getPendingInteraction,
      clearPendingInteraction,
      abortSession: vi.fn(async () => true),
      onInteractionResponsePrepared,
      onInteractionResponseAccepted,
      onInteractionResponseFailed,
    })).resolves.toEqual({ cancelled: false });

    expect(getPendingInteraction).toHaveBeenCalledTimes(1);
    expect(getPendingInteraction).toHaveBeenCalledWith("B");
    expect(respondToInteraction).toHaveBeenCalledTimes(1);
    expect(clearPendingInteraction).toHaveBeenCalledWith("B");
    expect(interactions).toEqual({ A: interactionA });
  });
});
