import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type AndroidUpdaterResult = {
  status: "install-started" | "permission-required";
};

type AndroidUpdaterPlugin = {
  downloadAndInstall(options: { url: string; sha256: string }): Promise<AndroidUpdaterResult>;
  installDownloaded(options: { sha256: string }): Promise<AndroidUpdaterResult>;
  requestInstallPermission(): Promise<{ opened: boolean }>;
  addListener(
    eventName: "downloadProgress",
    listener: (event: { progress: number; downloadedBytes: number; totalBytes: number }) => void,
  ): Promise<PluginListenerHandle>;
};

export const HppUpdater = registerPlugin<AndroidUpdaterPlugin>("HppUpdater");
