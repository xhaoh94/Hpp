export class AppShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;
  private immediateQuitAllowed = false;

  constructor(private readonly shutdown: () => Promise<void>) {}

  shouldInterceptQuit() {
    return !this.immediateQuitAllowed;
  }

  prepare() {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.shutdown();
    }
    return this.shutdownPromise;
  }

  async prepareAndAllowQuit() {
    await this.prepare();
    this.immediateQuitAllowed = true;
  }
}
