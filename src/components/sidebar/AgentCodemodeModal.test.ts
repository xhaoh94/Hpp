import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const MODAL = "src/components/sidebar/AgentCodemodeModal.tsx";
const SETTINGS_CSS = "src/components/sidebar/Settings.css";

function collectClassNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]*)`\}|\{"([^"]+)"\})/g)) {
    const raw = match[1] || match[2] || match[3] || "";
    for (const part of raw.split(/\$\{[^}]*\}/)) {
      for (const token of part.split(/\s+/)) {
        if (token && !token.includes("{") && !token.includes("?")) names.add(token);
      }
    }
  }
  return names;
}

describe("Codemode 设置弹窗的样式类", () => {
  it("引用的 class 都必须在 Settings.css 里有定义", () => {
    const used = collectClassNames(readWorkspaceFile(MODAL));
    const css = readWorkspaceFile(SETTINGS_CSS);
    const ignored = new Set(["settings-modal-overlay", "settings-modal", "settings-modal-header",
      "settings-modal-close", "settings-modal-content", "settings-general-heading-icon"]);
    const missing = [...used]
      .filter((name) => !ignored.has(name) && !css.includes(`.${name}`))
      .sort();
    expect(missing).toEqual([]);
  });

  /**
   * 回归：codemode 的配置项是 mode / inlineBudget，写进 pi 自己的
   * `~/.pi/agent/settings.json` 的 `codemode` 字段（扩展侧 readMode /
   * readInlineBudget 读的就是它）。别误写到 Hpp 的 hpp-data/settings.json。
   */
  it("配置读写指向 pi 的 settings.json，且只碰 codemode 这一个键", () => {
    const source = readWorkspaceFile("electron/agents/codemode-config.ts");
    expect(source).toContain('join(resolvePiAgentDir(agentDir), SETTINGS_FILE)');
    // 读-改-写，不能整体覆盖 settings.json
    expect(source).toContain("settings.codemode = {");
    expect(source).not.toContain("writeFile(filePath, JSON.stringify(config)");
  });

  it("mode 只有 on / only 两个取值，inlineBudget 回退到 pi 默认值", () => {
    const source = readWorkspaceFile("electron/agents/codemode-config.ts");
    expect(source).toContain('source.mode === "only" ? "only" : "on"');
    expect(source).toContain("DEFAULT_INLINE_BUDGET = 3000");
  });

  it("保存按钮复用 agent-mcp-save（btn-primary 本身没有尺寸）", () => {
    const source = readWorkspaceFile(MODAL);
    expect(source).toContain('className="btn-primary agent-mcp-save"');
  });

  /**
   * 回归：主进程的 `appliedSessionIds` 在「一个会话都没开」时是空的，但保存本身是成功的。
   * 无条件写「运行中的会话已重载」是在谎报 —— 要按 reconnected 分岔。
   */
  it("保存结果按 reconnected 分岔，不谎报已重载", () => {
    const source = readWorkspaceFile(MODAL);
    expect(source).toContain("result.reconnected ?");
    expect(source).toContain("新会话启动时生效");
    expect(source).not.toContain('|| "已保存，运行中的会话已重载"');
  });
});
