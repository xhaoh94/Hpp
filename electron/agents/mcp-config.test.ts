import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePiAgentPath, resolvePiAgentDir, writeMcpConfig } from "./mcp-config";

/**
 * agentDir 必须和 SDK 的口径一致（`dist/config.js:476` 的 `ENV_AGENT_DIR`），
 * 否则会出现「配置写在 A、Pi 读 B」：界面显示保存成功，Pi 连接时找不到 server。
 */
describe("resolvePiAgentDir", () => {
  const original = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  });

  it("显式传入的目录优先于一切", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/from-env/agent";
    expect(resolvePiAgentDir("C:/explicit/agent")).toBe("C:/explicit/agent");
  });

  it("读 PI_CODING_AGENT_DIR——这是 SDK 用的那个变量名", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/from-env/agent";
    expect(resolvePiAgentDir()).toBe("C:/from-env/agent");
  });

  it("空字符串与纯空白的变量值按未设置处理（不能解析成空路径）", () => {
    process.env.PI_CODING_AGENT_DIR = "";
    expect(resolvePiAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    process.env.PI_CODING_AGENT_DIR = "   ";
    expect(resolvePiAgentDir()).toBe(join(homedir(), ".pi", "agent"));
  });

  it("显式传入的空白串不生效，回退到环境变量", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/from-env/agent";
    expect(resolvePiAgentDir("  ")).toBe("C:/from-env/agent");
  });

  it("没有环境变量时回退到 ~/.pi/agent", () => {
    expect(resolvePiAgentDir()).toBe(join(homedir(), ".pi", "agent"));
  });

  it("空环境变量时也返回绝对路径，不会是空串", () => {
    expect(resolvePiAgentDir()).not.toBe("");
  });
});

/**
 * 回归：SDK 的 `getAgentDir()` 会先把环境变量过一遍 `normalizePath`
 * （`dist/utils/paths.js`：展开 `~`、转 Git Bash/MSYS/Cygwin/WSL 盘符路径、解析 `file://`）。
 * 宿主少做一步就会「配置写在 A、Pi 读 B」——`~/pi-agent` 在这边当字面量、在 pi 那边是家目录。
 */
describe("normalizePiAgentPath 对齐 SDK 的 normalizePath", () => {
  it("展开 ~ 与 ~/", () => {
    expect(normalizePiAgentPath("~")).toBe(homedir());
    expect(normalizePiAgentPath("~/pi-agent")).toBe(join(homedir(), "pi-agent"));
  });

  it("Windows 上把 Git Bash / WSL 的盘符路径转成原生形式", () => {
    if (process.platform !== "win32") return;
    expect(normalizePiAgentPath("/c/Users/x/agent")).toBe("C:\\Users\\x\\agent");
    expect(normalizePiAgentPath("/mnt/c/Users/x/agent")).toBe("C:\\Users\\x\\agent");
    expect(normalizePiAgentPath("/cygdrive/d/agent")).toBe("D:\\agent");
    // 不是盘符路径的就别动它。
    expect(normalizePiAgentPath("/tmp/agent")).toBe("/tmp/agent");
  });

  it("解析 file:// URL", () => {
    expect(normalizePiAgentPath("file:///C:/agent")).toBe(fileURLToPath("file:///C:/agent"));
  });

  it("普通绝对路径与首尾空白按原样（去空白）处理", () => {
    const absolute = join(homedir(), "custom-agent");
    expect(normalizePiAgentPath(absolute)).toBe(absolute);
    expect(normalizePiAgentPath(`  ${absolute}  `)).toBe(absolute);
  });
});

describe("writeMcpConfig 保留 mcp.json 的其他内容", () => {
  let root = "";
  let agentDir = "";
  let projectPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hpp-mcp-"));
    agentDir = join(root, "agent");
    projectPath = join(root, "project");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectPath, ".pi"), { recursive: true });
    // 项目级覆盖条目要有同名全局 server 才合法。
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { "shared": { command: "npx" } } }, null, 2),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 回归：pi 的 `autoEnableCodemode` 是「项目级覆盖全局」（`extensions/mcp/config.js` 的
   * readConfigFile 两个文件都读、项目后读后赢）。保存项目级配置时只提交 mcpServers，
   * 整体重建顶层会把项目文件里那份值静默删掉 —— 等于背着用户改了行为。
   */
  it("项目级保存不丢失 autoEnableCodemode 与其他顶层键", async () => {
    const projectFile = join(projectPath, ".pi", "mcp.json");
    await writeFile(projectFile, JSON.stringify({
      autoEnableCodemode: false,
      someFutureKey: 42,
      mcpServers: { shared: { enabled: true } },
    }, null, 2), "utf8");

    await writeMcpConfig(
      { scope: "project", servers: { shared: { enabled: false } }, projectPath },
      { agentDir },
    );

    const written = JSON.parse(await readFile(projectFile, "utf8"));
    expect(written.autoEnableCodemode).toBe(false);
    expect(written.someFutureKey).toBe(42);
    expect(written.mcpServers).toEqual({ shared: { enabled: false } });
  });

  it("全局显式传入 autoEnableCodemode 时才改写它", async () => {
    const globalFile = join(agentDir, "mcp.json");
    await writeMcpConfig(
      { scope: "global", servers: { shared: { command: "npx" } }, autoEnableCodemode: false },
      { agentDir },
    );
    expect(JSON.parse(await readFile(globalFile, "utf8")).autoEnableCodemode).toBe(false);

    await writeMcpConfig({ scope: "global", servers: { shared: { command: "npx" } } }, { agentDir });
    expect(JSON.parse(await readFile(globalFile, "utf8")).autoEnableCodemode).toBe(false);
  });

  it("配置文件不存在时照样能创建，校验不过就不落盘", async () => {
    const projectFile = join(projectPath, ".pi", "mcp.json");
    await rm(projectFile, { force: true });
    await writeMcpConfig(
      { scope: "project", servers: { shared: { enabled: false } }, projectPath },
      { agentDir },
    );
    expect(existsSync(projectFile)).toBe(true);

    await expect(writeMcpConfig(
      { scope: "project", servers: { orphan: { enabled: false } }, projectPath },
      { agentDir },
    )).rejects.toThrow(/同名全局 server/);
  });

  /** 坏文件不能静默覆盖 —— 读-改-写的前半段读不出来，就别写。 */
  it("现有文件不是合法 JSON 时拒绝保存，并指出是哪个文件", async () => {
    const projectFile = join(projectPath, ".pi", "mcp.json");
    await writeFile(projectFile, "{ 这不是 JSON", "utf8");

    await expect(writeMcpConfig(
      { scope: "project", servers: { shared: { enabled: false } }, projectPath },
      { agentDir },
    )).rejects.toThrow(/不是合法 JSON/);
    expect(await readFile(projectFile, "utf8")).toBe("{ 这不是 JSON");
  });
});
