import type { AppUpdateState } from "../src/types/ipc";

export const APP_UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export const shouldStopAppUpdatePolling = (state: AppUpdateState) =>
  state === "available" || state === "downloading" || state === "downloaded";

export const shouldRunPeriodicAppUpdateCheck = (state: AppUpdateState) =>
  state !== "checking" && !shouldStopAppUpdatePolling(state);
