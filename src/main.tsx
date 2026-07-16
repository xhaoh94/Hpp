import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppTheme, getStoredThemeHint, getThemeFromSettings } from "./lib/theme";
import "./index.css";

applyAppTheme(getStoredThemeHint());

async function bootstrap() {
  try {
    const settings = await window.electronAPI.loadData("settings");
    applyAppTheme(getThemeFromSettings(settings));
  } catch {
    applyAppTheme(getStoredThemeHint());
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
