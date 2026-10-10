import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizePiAgentPath as hostNormalize,
  resolvePiAgentDir as hostResolve,
} from "../../agents/mcp-config";
import {
  normalizePiAgentPath as workerNormalize,
  resolvePiAgentDir as workerResolve,
} from "./pi-agent-dir.mjs";

/**
 * worker 侧有一份主进程实现的副本（.mjs 没法 import .ts）。两份只要漂了，就会出现
 * 「配置写在 A、Pi 读 B」—— 而这个错误的症状是静默的（server 不生效、也不报错）。
 * 所以用同一组输入把两边钉在一起。
 */
const INPUTS = [
  "",
  "   ",
  "~",
  "~/pi-agent",
  "~\\pi-agent",
  join(homedir(), "custom-agent"),
  `  ${join(homedir(), "padded-agent")}  `,
  "/tmp/agent",
  "/c/Users/x/agent",
  "/mnt/c/Users/x/agent",
  "/cygdrive/d/agent",
  "C:\\Users\\x\\agent",
  "relative/agent",
  "file:///C:/agent",
];

const original = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
});

describe("worker 侧的 agentDir 解析与主进程保持一致", () => {
  it("normalizePiAgentPath 对同一组输入给出同样结果", () => {
    for (const input of INPUTS) {
      expect(workerNormalize(input), `输入 ${JSON.stringify(input)}`).toBe(hostNormalize(input));
    }
  });

  /** 光比对两边不足以证明对：要确认它们都真的做了归一，而不是一起原样返回。 */
  it("确实展开了 `~`", () => {
    expect(workerNormalize("~/pi-agent")).toBe(join(homedir(), "pi-agent"));
    expect(hostNormalize("~/pi-agent")).toBe(join(homedir(), "pi-agent"));
  });

  it("Windows 上确实把盘符路径转成了原生形式", () => {
    if (process.platform !== "win32") return;
    expect(workerNormalize("/c/Users/x/agent")).toBe("C:\\Users\\x\\agent");
    expect(hostNormalize("/c/Users/x/agent")).toBe("C:\\Users\\x\\agent");
  });

  it("resolvePiAgentDir 的优先级与回退一致", () => {
    expect(workerResolve()).toBe(hostResolve());
    expect(workerResolve("~/explicit")).toBe(hostResolve("~/explicit"));
    expect(workerResolve()).toBe(join(homedir(), ".pi", "agent"));

    process.env.PI_CODING_AGENT_DIR = "~/from-env";
    expect(workerResolve()).toBe(hostResolve());
    expect(workerResolve()).toBe(join(homedir(), "from-env"));
    // 显式值优先；空白串不算显式值，回落到环境变量。
    expect(workerResolve("~/explicit")).toBe(hostResolve("~/explicit"));
    expect(workerResolve("  ")).toBe(hostResolve("  "));
  });

  /** 空值不能被当成「用当前目录」——那样会把 mcp.json 写到进程 CWD 下。 */
  it("空值与纯空白都不会解析成空串", () => {
    expect(workerResolve("")).not.toBe("");
    expect(workerResolve("   ")).not.toBe("");
    process.env.PI_CODING_AGENT_DIR = "   ";
    expect(workerResolve()).toBe(join(homedir(), ".pi", "agent"));
  });
});
