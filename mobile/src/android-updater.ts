import { registerPlugin } from "@capacitor/core";

export type AndroidUpdaterResult = {
  status: "install-started" | "permission-required";
};

export type AndroidUpdaterDownloadStatus = {
  status: "idle" | "downloading" | "downloaded" | "failed";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  errorCode?: string;
};

type AndroidUpdaterPlugin = {
  startDownload(options: { url: string; sha256: string }): Promise<AndroidUpdaterDownloadStatus>;
  getUpdateStatus(options: { sha256: string }): Promise<AndroidUpdaterDownloadStatus>;
  installDownloaded(options: { sha256: string }): Promise<AndroidUpdaterResult>;
  requestInstallPermission(): Promise<{ opened: boolean; granted: boolean }>;
};

export const HppUpdater = registerPlugin<AndroidUpdaterPlugin>("HppUpdater");
