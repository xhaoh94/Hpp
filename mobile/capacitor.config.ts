import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hpp.mobile",
  appName: "Hpp",
  webDir: "dist",
  android: {
    allowMixedContent: true,
    // Keep WebView's native InputConnection. Capacitor's captureInput mode
    // replaces it with a generic BaseInputConnection, which cannot reliably
    // deliver IME composition/commit text to contenteditable editors.
    captureInput: false,
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    Camera: {
      saveToGallery: false,
    },
  },
};

export default config;
