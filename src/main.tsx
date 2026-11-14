import React from "react";
import ReactDOM from "react-dom/client";
import { QuickAsk } from "./components/quick-ask/QuickAsk";
import { applyAppTheme, getStoredThemeHint, getThemeFromSettings } from "./lib/theme";
import "./index.css";

const isQuickAsk = new URLSearchParams(window.location.search).get("quick") === "1";
if (isQuickAsk) document.documentElement.classList.add("quick-ask-mode");

applyAppTheme(getStoredThemeHint());

async function bootstrap() {
  try {
    const settings = await window.electronAPI.loadData("settings");
    applyAppTheme(getThemeFromSettings(settings));
  } catch {
    applyAppTheme(getStoredThemeHint());
  }

  const root = ReactDOM.createRoot(document.getElementById("root")!);
  if (isQuickAsk) {
    // 唤起床口只加载输入条，不把整个应用一起拉起来 —— 冷启动差一个数量级。
    root.render(<React.StrictMode><QuickAsk /></React.StrictMode>);
    return;
  }

  const { default: App } = await import("./App");
  root.render(<React.StrictMode><App /></React.StrictMode>);
}

void bootstrap();
