import { describe, expect, it } from "vitest";
import {
  isOverrideEntry,
  isServerEnabled,
  readMcpServerEntries,
  resolveEffectiveExposure,
  resolveExposureAlias,
  validateMcpServerEntry,
  validateMcpServers,
} from "./agent-mcp-config";

describe("MCP 配置校验（对齐 pi validateMcpServerConfig）", () => {
  it("接受 stdio 与 http 两种基本形态", () => {
    expect(validateMcpServerEntry("fs", { command: "npx", args: ["-y", "server"] })).toBeNull();
    expect(validateMcpServerEntry("docs", { url: "https://example.com/mcp" })).toBeNull();
    expect(validateMcpServerEntry("docs", { url: "http://localhost:3000/mcp" })).toBeNull();
  });

  it("拒绝既没有 command 也没有 url 的条目", () => {
    expect(validateMcpServerEntry("broken", {})).toContain("需要 command");
    expect(validateMcpServerEntry("broken", { description: "只有描述" })).toContain("需要 command");
  });

  it("server 名只允许字母数字下划线与连字符", () => {
    expect(validateMcpServerEntry("ok_name-1", { command: "x" })).toBeNull();
    expect(validateMcpServerEntry("bad name", { command: "x" })).toContain("非法");
    expect(validateMcpServerEntry("bad.name", { command: "x" })).toContain("非法");
    expect(validateMcpServerEntry("中文名", { command: "x" })).toContain("非法");
  });

  it("exposure 只接受 pi 的四个取值", () => {
    for (const value of ["codemode", "deferred", "direct", "hidden"]) {
      expect(validateMcpServerEntry("s", { command: "x", exposure: value })).toBeNull();
    }
    expect(validateMcpServerEntry("s", { command: "x", exposure: "nope" })).toContain("exposure");
    expect(validateMcpServerEntry("s", { command: "x", toolExposure: { a: "nope" } })).toContain("toolExposure");
  });

  /**
   * 回归：pi 有 `MCP_EXPOSURE_ALIASES`（`codemode-deferred` → `codemode`），旧写法是合法的。
   * 不认它就会让一条老条目报错，而弹窗是「任一错误就不落盘」—— 整个表单都改不了。
   */
  it("接受 pi 的旧曝光别名 codemode-deferred", () => {
    expect(validateMcpServerEntry("s", { command: "x", exposure: "codemode-deferred" })).toBeNull();
    expect(validateMcpServerEntry("s", { command: "x", toolExposure: { a: "codemode-deferred" } })).toBeNull();
    expect(validateMcpServerEntry("s", { exposure: "codemode-deferred" }, "project")).toBeNull();
    expect(resolveExposureAlias("codemode-deferred")).toBe("codemode");
    // 无关的值不能被顺手放过。
    expect(resolveExposureAlias("deferred")).toBe("deferred");
    expect(resolveExposureAlias(undefined)).toBeUndefined();
  });

  it("args 必须是字符串数组，env/headers 必须是字符串映射", () => {
    expect(validateMcpServerEntry("s", { command: "x", args: "nope" })).toContain("args");
    expect(validateMcpServerEntry("s", { command: "x", args: [1] })).toContain("args");
    expect(validateMcpServerEntry("s", { command: "x", env: { A: 1 } })).toContain("env");
    expect(validateMcpServerEntry("s", { url: "https://a.test/mcp", headers: { A: 1 } })).toContain("headers");
  });

  it("url 必须是 http/https，SSE 已废弃", () => {
    expect(validateMcpServerEntry("s", { url: "ftp://a.test" })).toContain("http");
    expect(validateMcpServerEntry("s", { url: "not a url" })).toContain("http");
    expect(validateMcpServerEntry("s", { type: "sse", url: "https://a.test" })).toContain("SSE");
  });

  it("auth 要求 https 或回环地址，且只能配在全局", () => {
    expect(validateMcpServerEntry("s", { url: "https://a.test/mcp", auth: { provider: "p" } })).toBeNull();
    expect(validateMcpServerEntry("s", { url: "http://localhost/mcp", auth: { provider: "p" } })).toBeNull();
    expect(validateMcpServerEntry("s", { url: "http://a.test/mcp", auth: { provider: "p" } })).toContain("https");
    expect(validateMcpServerEntry("s", { url: "https://a.test/mcp", auth: {} })).toContain("auth.provider");
    // 项目级不允许自带 auth（否则仓库能决定凭据去向）。
    expect(validateMcpServerEntry("s", { url: "https://a.test/mcp", auth: { provider: "p" } }, "project"))
      .toContain("全局");
  });

  it("timeout 必须是正数秒", () => {
    expect(validateMcpServerEntry("s", { command: "x", timeout: 30 })).toBeNull();
    expect(validateMcpServerEntry("s", { command: "x", timeout: 0 })).toContain("timeout");
    expect(validateMcpServerEntry("s", { command: "x", timeout: "30" })).toContain("timeout");
  });

  it("项目级覆盖条目只能含 enabled/exposure/toolExposure", () => {
    expect(isOverrideEntry({ enabled: false })).toBe(true);
    expect(isOverrideEntry({ exposure: "hidden" })).toBe(true);
    expect(isOverrideEntry({ command: "x" })).toBe(false);
    expect(validateMcpServerEntry("s", { enabled: false }, "project")).toBeNull();
    expect(validateMcpServerEntry("s", { enabled: false, command: "x" }, "project")).toBeNull();
    // 命令不该出现在覆盖条目里 —— 那是全局该管的事。
    expect(validateMcpServerEntry("s", { enabled: false, cwd: "/tmp" }, "project")).toContain("覆盖条目");
  });

  it("覆盖条目没有同名全局 server 时报错", () => {
    const errors = validateMcpServers(
      { mcpServers: { orphan: { enabled: false } } },
      "project",
      ["other"],
    );
    expect(errors[0]).toContain("同名全局 server");
    // 有同名全局就不报。
    expect(validateMcpServers({ mcpServers: { orphan: { enabled: false } } }, "project", ["orphan"])).toEqual([]);
  });

  it("只差 - 和 _ 的 server 名视为冲突", () => {
    const errors = validateMcpServers(
      { mcpServers: { "my-server": { command: "a" }, my_server: { command: "b" } } },
      "global",
    );
    expect(errors.some((error) => error.includes("冲突"))).toBe(true);
  });

  it("顶层结构错误要被拦住", () => {
    // toContain 对数组是「元素完全匹配」，所以断言元素本身。
    expect(validateMcpServers("nope", "global")[0]).toContain("顶层");
    expect(validateMcpServers({ mcpServers: "nope" }, "global")[0]).toContain("mcpServers");
    expect(validateMcpServers(undefined, "global")).toEqual([]);
    expect(validateMcpServers({ mcpServers: {} }, "global")).toEqual([]);
  });
});

describe("MCP 条目读取", () => {
  it("标注覆盖条目与缺失基项", () => {
    const entries = readMcpServerEntries(
      {
        mcpServers: {
          shared: { enabled: false },
          orphan: { exposure: "hidden" },
          own: { command: "x" },
        },
      },
      "project",
      ["shared"],
    );
    expect(entries.map((entry) => entry.name)).toEqual(["shared", "orphan", "own"]);
    expect(entries[0].isOverride).toBe(true);
    expect(entries[0].overrideMissing).toBe(false);
    // 覆盖了不存在的全局 server —— 这条配置是死的，要标出来。
    expect(entries[1].overrideMissing).toBe(true);
    expect(entries[2].isOverride).toBe(false);
  });

  it("全局作用域没有覆盖概念", () => {
    const entries = readMcpServerEntries({ mcpServers: { a: { command: "x" } } }, "global");
    expect(entries[0].isOverride).toBe(false);
    expect(entries[0].overrideMissing).toBe(false);
  });
});
describe("生效 exposure 的合并", () => {
  const entry = (name: string, exposure: string | undefined, isOverride = false) => ({
    name,
    config: exposure ? { exposure } : {},
    isOverride,
  });

  it("自己的值优先", () => {
    expect(resolveEffectiveExposure(entry("a", "deferred") as never, [
      { name: "a", config: { exposure: "hidden" } },
    ])).toBe("deferred");
  });

  it("覆盖条目缺省时继承全局同名 server 的 exposure", () => {
    // 这是 UI 提示曾经漏掉的情形：覆盖条目 exposure 是 undefined，
    // 真正生效的是全局那个 codemode。
    expect(resolveEffectiveExposure(entry("a", undefined, true) as never, [
      { name: "a", config: { exposure: "codemode" } },
    ])).toBe("codemode");
  });

  it("找不到同名全局 server 时回退 codemode（pi 的默认档）", () => {
    expect(resolveEffectiveExposure(entry("a", undefined, true) as never, [
      { name: "other", config: { exposure: "codemode" } },
    ])).toBe("codemode");
    expect(resolveEffectiveExposure(entry("a", undefined, true) as never)).toBe("codemode");
  });

  it("非覆盖条目缺省是 codemode（不查全局）", () => {
    // pi 侧收在 `config.exposure ?? "codemode"`：没写 exposure 的 server 是「仅脚本可调」，
    // 不是「直接暴露」。按 direct 处理会让 UI 显示错误的档位、并漏掉 codemode 未启用的警告。
    expect(resolveEffectiveExposure(entry("a", undefined, false) as never, [
      { name: "a", config: { exposure: "direct" } },
    ])).toBe("codemode");
  });

  it("旧别名参与合并时按归一后的值算", () => {
    expect(resolveEffectiveExposure(entry("a", "codemode-deferred", false) as never)).toBe("codemode");
    expect(resolveEffectiveExposure(entry("a", undefined, true) as never, [
      { name: "a", config: { exposure: "codemode-deferred" } },
    ])).toBe("codemode");
  });
});

describe("enabled 判定", () => {
  it("只有显式 false 才算禁用", () => {
    expect(isServerEnabled({ config: {}, isOverride: false })).toBe(true);
    expect(isServerEnabled({ config: { enabled: true }, isOverride: false })).toBe(true);
    expect(isServerEnabled({ config: { enabled: false }, isOverride: false })).toBe(false);
    // 覆盖条目的enabled: false 是「在这个项目里关掉它」
    expect(isServerEnabled({ config: { enabled: false }, isOverride: true })).toBe(false);
  });
});
