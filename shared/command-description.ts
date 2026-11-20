/**
 * 命令条目标题的兜底描述。
 *
 * 为什么需要：命令行的界面标题优先用「模型写的 description」（例如
 * 「查看空闲时长的渲染位置」）。Pi 在 worker 里会给缺失的 description 补一句；
 * 其他 Agent 没有模型描述时，Hpp 会根据命令生成动作标题。
 *
 * 这里按命令首个词给一个稳定的中文动作描述，至少能看出这条命令是在干什么。
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
  "get-content": "读取项目文件",
  "get-childitem": "列出项目文件",
  "select-string": "搜索文件内容",
  "test-path": "检查文件路径",
  "get-location": "查看当前目录",
  "set-content": "写入项目文件",
  "add-content": "追加项目文件内容",
  "new-item": "创建文件或目录",
  "remove-item": "删除文件或目录",
  "copy-item": "复制文件",
  "move-item": "移动文件",
  head: "查看文件开头",
  tail: "查看文件末尾",
  wc: "统计行数",
  git: "查看 Git 信息",
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

const stripPath = (value: string) => value.replace(/^.*[\\/]/, "").toLowerCase();

/** 按引号切分命令，保留 `-Command 'Get-Content ...'` 里的脚本整体。 */
const tokenizeCommand = (text: string): string[] => {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          token += "'";
          index += 1;
        } else {
          quote = "";
        }
      } else if (char === "\\" && quote === '"' && text[index + 1] === '"') {
        token += '"';
        index += 1;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += char;
    }
  }
  if (token) tokens.push(token);
  return tokens;
};

/** 取 shell 包装里的实际脚本，例如 PowerShell `-Command` 后的内容。 */
const unwrapShellCommand = (text: string): string => {
  let current = text.trim().replace(/^&\s*/, "");
  for (let depth = 0; depth < 3; depth += 1) {
    const words = tokenizeCommand(current);
    const shell = stripPath(words[0] || "").replace(/\.exe$/, "");
    if (!SHELL_WRAPPERS.has(shell) || words.length < 2) return current;

    let next = "";
    if (shell === "pwsh" || shell === "powershell") {
      const commandIndex = words.findIndex((word) => /^-(?:command|c)$/i.test(word));
      next = commandIndex >= 0 ? words.slice(commandIndex + 1).join(" ") : "";
    } else if (shell === "cmd") {
      const commandIndex = words.findIndex((word) => /^\/(?:c|k)$/i.test(word));
      next = commandIndex >= 0 ? words.slice(commandIndex + 1).join(" ") : "";
    } else {
      let index = 1;
      while (index < words.length && words[index].startsWith("-")) index += 1;
      next = words.slice(index).join(" ");
    }
    if (!next || next === current) return current;
    current = next;
  }
  return current;
};

const getCommandWords = (text: string): string[] => tokenizeCommand(unwrapShellCommand(text))
  .map((word) => word.replace(/^[({&]+/, "").replace(/[;,|]+$/, ""))
  .filter(Boolean);

/** 取实际命令动词：同时识别 Codex 常见的 PowerShell -Command 包装。 */
const getHeadCommandWord = (text: string): string => {
  const words = getCommandWords(text);
  return stripPath(words[0] || "");
};

const describeGitCommand = (words: string[], text: string): string => {
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    index += ["-c", "--git-dir", "--work-tree"].includes(words[index].toLowerCase()) ? 2 : 1;
  }
  const subcommand = (words[index] || "").toLowerCase();
  const mentionsCodex = /\bcodex\b/i.test(text);
  if (subcommand === "status") return "查看 Git 工作区状态";
  if (subcommand === "log") return mentionsCodex ? "查看 Codex 相关提交记录" : "查看 Git 提交记录";
  if (subcommand === "diff") return "查看 Git 代码变更";
  if (subcommand === "show") return "查看 Git 提交内容";
  if (subcommand === "branch") return "查看 Git 分支";
  if (subcommand === "rev-parse") return "读取 Git 仓库信息";
  return COMMAND_DESCRIPTION_VERBS.git;
};

const describeNpmCommand = (words: string[]): string => {
  const action = (words[1] || "").toLowerCase();
  if (action === "run" || action === "test") return "运行项目脚本";
  if (action === "install" || action === "i" || action === "ci") return "安装项目依赖";
  return COMMAND_DESCRIPTION_VERBS.npm;
};

const describeProjectCommand = (head: string, text: string): string | undefined => {
  const mentionsCodex = /\bcodex\b/i.test(text);
  const mentionsAgentPlugin = /agent[-_/ ]?plugin/i.test(text);
  const mentionsDocs = /(?:^|[\\/\s])docs?(?:[\\/\s.]|$)|\.md\b/i.test(text);
  if (head === "get-childitem" || head === "ls" || head === "dir") {
    if (mentionsCodex && /git\s+status/i.test(text)) return "检查 Codex 插件和 Git 状态";
    if (mentionsCodex && mentionsAgentPlugin) return "列出 Codex 插件文件";
    if (mentionsDocs) return "列出项目文档";
    return "列出项目文件";
  }
  if (head === "get-content" || head === "cat" || head === "head" || head === "tail") {
    if (mentionsCodex && mentionsAgentPlugin) return "读取 Codex 插件文档和配置";
    return mentionsDocs ? "读取项目文档" : "读取项目文件";
  }
  if (head === "rg" || head === "grep" || head === "select-string") {
    if (mentionsCodex && mentionsAgentPlugin) return "搜索 Codex 插件代码";
    if (mentionsCodex) return "搜索 Codex 相关代码";
    return "搜索项目代码";
  }
  return undefined;
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
  const words = getCommandWords(text);
  const head = getHeadCommandWord(text);
  if (head === "git") return describeGitCommand(words, text);
  if (head === "npm" || head === "pnpm" || head === "yarn") return describeNpmCommand(words);
  const projectDescription = describeProjectCommand(head, text);
  if (projectDescription) return projectDescription;
  return COMMAND_DESCRIPTION_VERBS[head] || `执行 ${head || "命令"}`;
};
