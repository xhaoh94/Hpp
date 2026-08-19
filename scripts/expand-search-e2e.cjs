const { app, BrowserWindow } = require("electron");

const targetUrl = process.argv[2];
if (!targetUrl) throw new Error("Missing test page URL");

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    width: 760,
    height: 940,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    errors.push(`renderer gone: ${details.reason}`);
  });

  await window.loadURL(targetUrl);
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    document.readyState === "complete" ? done() : addEventListener("load", done, { once: true });
  })`);

  const result = await window.webContents.executeJavaScript(`(async () => {
    const list = document.querySelector(".editor-expand-search-list");
    if (!list) return { ok: false, reason: "missing list" };
    const firstGroup = document.querySelector(".editor-expand-search-group-head");
    if (!firstGroup) return { ok: false, reason: "missing first group" };
    firstGroup.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const maxScrollTop = list.scrollHeight - list.clientHeight;
    const positions = [0, 300, 700, 1100, 1600, 2300, 3100, 3900, 4400,
      maxScrollTop, maxScrollTop * 0.13, maxScrollTop * 0.91,
      maxScrollTop * 0.42, maxScrollTop * 0.76, maxScrollTop * 0.25, maxScrollTop, 1];
    const checks = [];
    const readCheck = (requested) => {
      const listRect = list.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".editor-expand-search-vrow")];
      const intersecting = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > listRect.top && rect.top < listRect.bottom;
      });
      return {
        requested: Math.round(requested),
        actual: list.scrollTop,
        rowCount: rows.length,
        intersectingCount: intersecting.length,
        firstText: intersecting[0]?.textContent?.slice(0, 60) ?? "",
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    };
    for (const position of positions) {
      const startedAt = performance.now();
      list.scrollTop = position;
      list.dispatchEvent(new Event("scroll"));
      const check = readCheck(position);
      check.durationMs = performance.now() - startedAt;
      checks.push(check);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    checks.push({ ...readCheck(positions.at(-1)), durationMs: 0 });
    return {
      ok: checks.every((check) =>
        check.rowCount > 0 && check.intersectingCount > 0 && check.durationMs <= 100
      ),
      checks,
    };
  })()`);

  const relevantErrors = errors.filter((message) => !message.includes("Electron Security Warning"));
  if (relevantErrors.length > 0) result.errors = relevantErrors;
  console.log(JSON.stringify(result, null, 2));
  await window.close();
  app.quit();
  if (!result.ok || relevantErrors.length > 0) process.exitCode = 1;
});
