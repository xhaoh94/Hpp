/**
 * 修补 electron-builder 的 npm 依赖树收集器（仅 Windows 需要）。
 *
 * 背景：`app-builder-lib` 会执行 `npm list --json ...` 来收集生产依赖，在 Windows
 * 上它通过 `cmd.exe /d /s /c "<command> <args>"` 启动包管理器。当 command 是
 * `C:\Program Files\nodejs\npm.cmd` 这种**带空格**的绝对路径时，只给命令本身加引号
 * 是不够的：`/s` 会剥掉最外层引号，Node 又会二次转义内部引号，cmd 最终把引号当字面
 * 字符，得到「不是内部或外部命令」并且 stdout 为空，最终表现为
 * `No JSON content found in output`。
 *
 * 正确写法是把整条命令行再包一层引号（`""<cmd>" <args>"`），并用
 * `windowsVerbatimArguments` 阻止 Node 二次转义。
 *
 * 这是对 node_modules 的本地补丁，重新 `npm install` 会被覆盖，所以挂在 postinstall
 * 上跑。脚本是幂等的：已打过就跳过。
 */
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const MARKER = "HPP_PATCH_NPM_COLLECTOR";
const target = join(
  __dirname,
  "..",
  "node_modules",
  "app-builder-lib",
  "out",
  "node-module-collector",
  "nodeModulesCollector.js",
);

if (!existsSync(target)) {
  console.warn("[patch-app-builder-lib] 未找到 app-builder-lib，跳过（打包时才会用到）");
  process.exit(0);
}

let source = readFileSync(target, "utf8");
if (source.includes(MARKER)) {
  console.log("[patch-app-builder-lib] 已是最新，跳过");
  process.exit(0);
}

const selectorAnchor = 'const [spawnCommand, spawnArgs] = process.platform === "win32"';
const selectorStart = source.indexOf(selectorAnchor);
if (selectorStart < 0) {
  throw new Error("[patch-app-builder-lib] 未找到 spawn 选择逻辑，electron-builder 版本可能已变更");
}
const selectorEndAnchor = ": [command, args];";
const selectorEnd = source.indexOf(selectorEndAnchor, selectorStart);
if (selectorEnd < 0) {
  throw new Error("[patch-app-builder-lib] 未找到 spawn 选择逻辑的结尾，electron-builder 版本可能已变更");
}

// 把可能已存在的旧 cmdQuote 行一起纳入替换区间，保证幂等且不重复声明。
const quoteAnchor = "const cmdQuote =";
const quoteIndex = source.lastIndexOf(quoteAnchor, selectorStart);
let replaceStart = quoteIndex >= 0 && selectorStart - quoteIndex < 600
  ? source.lastIndexOf("\n", quoteIndex) + 1
  : source.lastIndexOf("\n", selectorStart) + 1;
// 吞掉紧邻在上方的注释行（旧补丁会留下说明注释），避免重复注释堆积。
for (let step = 0; step < 12; step += 1) {
  const prevStart = source.lastIndexOf("\n", replaceStart - 2) + 1;
  if (prevStart <= 0) break;
  if (!source.slice(prevStart, replaceStart).trim().startsWith("//")) break;
  replaceStart = prevStart;
}
const replaceEnd = selectorEnd + selectorEndAnchor.length;

const replacement = [
  `        // [${MARKER}] cmd.exe /s /c 必须把整条命令行再包一层引号，否则`,
  "        // \"C:\\Program Files\\nodejs\\npm.cmd\" 这种带空格的路径会被当成字面量，",
  "        // 输出为空 → \"No JSON content found in output\"。",
  '        const cmdQuote = (value) => /[\\s"&|<>^()]/.test(value) ? `"${String(value).replace(/"/g, \'""\')}"` : String(value);',
  '        const [spawnCommand, spawnArgs] = process.platform === "win32"',
  '            ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(cmdQuote).join(" ")}"`]]',
  "            : [command, args];",
].join("\n");

source = `${source.slice(0, replaceStart)}${replacement}${source.slice(replaceEnd)}`;

// spawn options 里补 windowsVerbatimArguments，避免 Node 给已经手工加过引号的
// 命令行再转义一层。
const spawnOptionsAnchor = "const child = childProcess.spawn(spawnCommand, spawnArgs, {";
const spawnOptionsStart = source.indexOf(spawnOptionsAnchor);
if (spawnOptionsStart < 0) {
  throw new Error("[patch-app-builder-lib] 未找到 spawn 调用，electron-builder 版本可能已变更");
}
const spawnOptionsEnd = source.indexOf("});", spawnOptionsStart);
if (spawnOptionsEnd < 0) {
  throw new Error("[patch-app-builder-lib] 未找到 spawn 调用结尾，electron-builder 版本可能已变更");
}
const spawnOptions = source.slice(spawnOptionsStart, spawnOptionsEnd);
if (!spawnOptions.includes("windowsVerbatimArguments")) {
  source = `${source.slice(0, spawnOptionsEnd).replace(/[ \t]*$/, "")}`
    + `\n                windowsVerbatimArguments: process.platform === "win32",\n            `
    + `${source.slice(spawnOptionsEnd)}`;
}

writeFileSync(target, source, "utf8");
console.log("[patch-app-builder-lib] 已修补 npm 依赖树收集器的 Windows 命令行转义");
