/**
 * 命令条目标题的兜底描述。
 *
 * 为什么需要：命令行的界面标题优先用「模型写的 description」（例如
 * 「查看空闲时长的渲染位置」）。Pi 在 worker 里会给缺失的 description 补一句，
 * Claude/Codex/Droid/OpenCode 不做这件事，标题就退化成「命令」或原始命令文本。
 *
 * 这里按命令首个词给一个稳定的中文动词，至少能看出这条命令是在干什么。
 * 注意：Pi 的 worker 是直接拷贝进产物的 .mjs，不能 import 这个 TS 模块，
 * 所以 `electron/plugin-backends/pi/worker.mjs` 里保留了一份同样的表；
 * 改动词表时两处要同步。
 */
const COMMAND_DESCRIPTION_VERBS: Record<string, string> = {
  grep: "检索内容",
  rg: "检索内容",
  find: "查找文件",
  fd: "查找文件",
  ls: "列出目录",
  dir: "列出目录",
  cat: "查看文件",
  head: "查看文件开头",
  tail: "查看文件末尾",
  wc: "统计行数",
  git: "执行 Git 操作",
  npm: "运行 npm 命令",
  pnpm: "运行 pnpm 命令",
  yarn: "运行 yarn 命令",
  node: "运行 Node 脚本",
  curl: "发起网络请求",
  sed: "处理文本",
};

/** 常见的 shell 包装，真正常跑的动词在它们后面。 */
const SHELL_WRAPPERS = new Set([
  "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd", "cmd.exe",
]);

/** 取真正要执行的动词：跳过 shell 名与 -flag，例如 `bash -lc grep …` → grep。 */
const getHeadCommandWord = (text: string): string => {
  const words = text.split(/\s+/).filter(Boolean);
  let index = 0;
  const stripPath = (value: string) => value.replace(/^.*[\\/]/, "").toLowerCase();
  if (words.length > 1 && SHELL_WRAPPERS.has(stripPath(words[0]))) {
    index = 1;
    while (index < words.length && (words[index].startsWith("-") || SHELL_WRAPPERS.has(stripPath(words[index])))) {
      index += 1;
    }
  }
  return stripPath(words[index] || "");
};

/**
 * 从命令文本推断一句简短描述；没有命令时退回工具名。
 * 结果只用于界面标题，不参与任何执行逻辑。
 */
export const fallbackCommandDescription = (command: unknown, toolName?: unknown): string => {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) {
    const name = typeof toolName === "string" ? toolName.trim() : "";
    return name ? `执行 ${name}` : "执行命令";
  }
  const head = getHeadCommandWord(text);
  return COMMAND_DESCRIPTION_VERBS[head] || `执行 ${head || "命令"}`;
};
