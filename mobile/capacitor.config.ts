import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hpp.mobile",
  appName: "Hpp",
  webDir: "dist",
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    Camera: {
      saveToGallery: false,
    },
  },
};

export default config;
