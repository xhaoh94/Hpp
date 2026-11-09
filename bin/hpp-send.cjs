#!/usr/bin/env node
/**
 * 任意编辑器到 Hpp 的通用发送端。
 *
 * 只有 Node 内置模块，不依赖 Hpp 的源码，所以 Zed / Vim / Emacs 这类「只能
 * spawn 一个进程」的编辑器直接用 tasks 或键位调用它即可，不必写插件。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const DISCOVERY_FILENAME = "editor-bridge.json";
const SEND_PATH = "/api/v1/editor/send";
const TOKEN_HEADER = "x-hpp-bridge-token";
const MAX_TEXT_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

const USAGE = `用法: hpp-send --file <路径> [选项]

  --folder             把 --file 当作文件夹引用发送（不读内容）
  --start <N>          起始行（1 起）
  --end <N>            结束行（1 起），缺省等于 --start
  --text <内容>        字面内容（未保存的缓冲区必须给）
  --text-env <变量名>  从环境变量读字面内容，例如 Zed 的 ZED_SELECTED_TEXT
  --text-stdin         从标准输入读字面内容
  --client <名字>      来源标识，默认 cli
  --language <名字>    语言标识
  --session <id>       插入到指定会话
  --focus              插入后把 Hpp 窗口提到前台
  --discovery <路径>   指定 editor-bridge.json
`;

function parseArgs(argv) {
  const options = { client: "cli", start: undefined, end: undefined, text: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${token} 缺少参数`);
      index += 1;
      return value;
    };
    switch (token) {
      case "--file": options.file = next(); break;
      case "--start": options.start = Number(next()); break;
      case "--end": options.end = Number(next()); break;
      case "--text": options.text = next(); break;
      case "--text-env": options.textEnv = next(); break;
      case "--text-stdin": options.textStdin = true; break;
      case "--folder": options.folder = true; break;
      case "--client": options.client = next(); break;
      case "--language": options.language = next(); break;
      case "--session": options.session = next(); break;
      case "--discovery": options.discovery = next(); break;
      case "--focus": options.focus = true; break;
      case "-h":
      case "--help": options.help = true; break;
      default: throw new Error(`未知参数: ${token}`);
    }
  }
  return options;
}

function discoveryCandidates(explicit) {
  if (explicit) return [explicit];
  const candidates = [];
  if (process.env.HPP_BRIDGE_DISCOVERY) candidates.push(process.env.HPP_BRIDGE_DISCOVERY);
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    candidates.push(path.join(appData, "hpp", "hpp-data", DISCOVERY_FILENAME));
  } else if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "hpp", "hpp-data", DISCOVERY_FILENAME));
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    candidates.push(path.join(config, "hpp", "hpp-data", DISCOVERY_FILENAME));
  }
  return candidates;
}

function readDiscovery(explicit) {
  for (const candidate of discoveryCandidates(explicit)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && parsed.port && parsed.token) return parsed;
    } catch {
      // 换下一个候选路径。
    }
  }
  return null;
}

function post(discovery, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request({
      host: discovery.host || "127.0.0.1",
      port: discovery.port,
      path: SEND_PATH,
      method: "POST",
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        [TOKEN_HEADER]: discovery.token,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          reject(new Error(`Hpp 返回了无法解析的响应: ${text.slice(0, 200)}`));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300 && parsed && parsed.ok) resolve(parsed);
        else reject(new Error((parsed && parsed.error) || `Hpp 返回 ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("连接 Hpp 超时")));
    request.on("error", (error) => reject(error.code === "ECONNREFUSED"
      ? new Error("Hpp 没有在监听（可能已经退出）。")
      : error));
    request.write(payload);
    request.end();
  });
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.file) throw new Error("缺少 --file。\n\n" + USAGE);

  let text = options.text;
  if (options.textEnv) text = process.env[options.textEnv];
  if (options.textStdin) text = await readStdin();

  const startLine = Number.isFinite(options.start) ? options.start : undefined;
  const endLine = Number.isFinite(options.end) ? options.end : startLine;
  const kind = options.folder ? "folder" : startLine === undefined ? "file" : "selection";

  const body = {
    version: 1,
    client: options.client,
    kind,
    path: options.file,
    startLine: kind === "selection" ? startLine : undefined,
    endLine: kind === "selection" ? Math.max(endLine, startLine) : undefined,
    language: options.language,
    sessionId: options.session,
    focus: options.focus,
  };
  if (typeof text === "string" && text.length > 0) {
    if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES) body.text = text;
    else process.stderr.write("内容超过 512 KB，只发送路径和行号。\n");
  }

  const discovery = readDiscovery(options.discovery);
  if (!discovery) throw new Error("找不到 editor-bridge.json，Hpp 启动过了吗？");
  await post(discovery, body);
  process.stdout.write("ok\n");
}

main().catch((error) => {
  process.stderr.write(`hpp-send: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
