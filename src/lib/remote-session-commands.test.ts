import { describe, expect, it, vi } from "vitest";
import { abortRemoteSession, type RemoteCommandContext } from "./remote-session-commands";

const createContext = (success: boolean) => {
  const abortSession = vi.fn(async () => success);
  const clearPendingInteraction = vi.fn();
  const context: RemoteCommandContext = {
    pendingInteraction: null,
    abortSession,
    clearPendingInteraction,
  };
  return { abortSession, clearPendingInteraction, context };
};

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
