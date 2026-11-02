import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 启动耗时的可追溯日志。
 *
 * 控制台日志在正式包（内网机器）里拿不到，而「会话启动很慢」这类问题必须
 * 事后分析，所以带时间戳的行同时落一份到 `$HPP_DATA_DIR/logs/hpp-timing.log`。
 * 只给显式调用者用（`[Hpp timing]` / `[pi-init]` 这类行），不做 console 全局劫持。
 * 写盘失败一律吞掉：性能日志不能影响会话创建。
 */
const LOG_DIR_NAME = "logs";
const LOG_FILE_NAME = "hpp-timing.log";
// 单文件 2MB 就轮转一份，避免长期运行无限增长。
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let cachedDataDir: string | null = null;
let cachedLogFile = "";

export function getTimingLogFile(): string {
  const dataDir = String(process.env.HPP_DATA_DIR || "").trim();
  if (dataDir === cachedDataDir) return cachedLogFile;
  cachedDataDir = dataDir;
  cachedLogFile = dataDir ? join(dataDir, LOG_DIR_NAME, LOG_FILE_NAME) : "";
  return cachedLogFile;
}

function rotateIfNeeded(file: string) {
  try {
    if (!existsSync(file) || statSync(file).size <= MAX_LOG_BYTES) return;
    const rotated = `${file}.1`;
    rmSync(rotated, { force: true });
    renameSync(file, rotated);
  } catch {
    // 轮转失败就继续往原文件追加，不影响主流程。
  }
}

/** 只写文件，不打印。用于已经在别处 console 过的行。 */
export function appendTimingLog(line: string) {
  const file = getTimingLogFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // 性能日志写失败必须静默。
  }
}

/** 打印并落盘。 */
export function logTiming(line: string) {
  console.log(line);
  appendTimingLog(line);
}

/** 多行 stderr（worker 转发过来的）按行落盘。 */
export function appendTimingLogLines(prefix: string, text: string) {
  const body = String(text || "").trimEnd();
  if (!body) return;
  for (const line of body.split(/\r?\n/)) {
    if (line.trim()) appendTimingLog(`${prefix} ${line}`);
  }
}
