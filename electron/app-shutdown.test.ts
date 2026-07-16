import { describe, expect, it, vi } from "vitest";
import { AppShutdownCoordinator } from "./app-shutdown";

describe("AppShutdownCoordinator", () => {
  it("keeps intercepting quit until shutdown has completed", async () => {
    let finishShutdown: (() => void) | undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => {
      finishShutdown = resolve;
    }));
    const coordinator = new AppShutdownCoordinator(shutdown);

    const preparation = coordinator.prepareAndAllowQuit();

    expect(coordinator.shouldInterceptQuit()).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);

    finishShutdown?.();
    await preparation;

    expect(coordinator.shouldInterceptQuit()).toBe(false);
  });

  it("runs shutdown only once for repeated quit requests", async () => {
    const shutdown = vi.fn(async () => undefined);
    const coordinator = new AppShutdownCoordinator(shutdown);

    await Promise.all([
      coordinator.prepareAndAllowQuit(),
      coordinator.prepareAndAllowQuit(),
    ]);

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
