import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkspaceFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const MCP_MODAL = "src/components/sidebar/AgentMcpModal.tsx";
const SETTINGS_CSS = "src/components/sidebar/Settings.css";

/**
 * 收集源码里用到的 className token。
 * 只取形如 `className="a b c"` 与模板字符串里的静态部分。
 */
function collectClassNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]*)`\}|\{"([^"]+)"\})/g)) {
    const raw = match[1] || match[2] || match[3] || "";
    // 去掉模板插值表达式，只留静态片段
    for (const part of raw.split(/\$\{[^}]*\}/)) {
      for (const token of part.split(/\s+/)) {
        if (token && !token.includes("{") && !token.includes("?")) names.add(token);
      }
    }
  }
  return names;
}

describe("MCP 设置弹窗的样式类", () => {
  /**
   * 回归测试：`settings-modal-footer` / `btn-secondary` 这两个 class 在
   * Settings.css 里**从来没有定义过**，引用它们会让元素完全没有样式 ——
   * 实际表现是 footer 无边框无背景、按钮被挤成一团。
   * 凡是 MCP 弹窗用到的 class，都必须在 CSS 里有对应规则。
   */
  it("引用的 class 都必须在 Settings.css 里有定义", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    const css = readWorkspaceFile(SETTINGS_CSS);
    const used = collectClassNames(source);
    // 图标组件会生成自己的类，不归本文件管。
    const ignored = new Set(["settings-modal-overlay", "settings-modal", "settings-modal-header",
      "settings-modal-close", "settings-modal-content", "settings-general-heading-icon"]);
    const missing = [...used]
      .filter((name) => !ignored.has(name) && !css.includes(`.${name}`))
      .sort();
    expect(missing).toEqual([]);
  });

  it("footer 用的是有定义的 class，不是不存在的 settings-modal-footer", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain('className="agent-mcp-footer"');
    expect(source).not.toContain("settings-modal-footer");
    expect(source).not.toContain("btn-secondary");
  });

  /** 主按钮需要叠 btn-action 才有尺寸——btn-primary 本身只有背景色。 */
  it("保存按钮同时带 btn-primary 与 agent-mcp-save", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain('className="btn-primary agent-mcp-save"');
    const css = readWorkspaceFile(SETTINGS_CSS);
    expect(css).toContain(".agent-mcp-save {");
  });

  /** 内容少时 modal 会贴内容高度收缩，底部会露出背景层的渠道列表。 */
  it("给弹窗设了最小高度，避免底部露背景", () => {
    const css = readWorkspaceFile(SETTINGS_CSS);
    expect(css).toContain(".settings-modal.agent-mcp-modal {");
    expect(css).toMatch(/min-height:\s*min\(\d+px/);
  });
});

describe("MCP 弹窗的状态管理约定", () => {
  it("切换作用域时重新读取全局快照，并忽略过期请求", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain("const loadScopeRequestRef = useRef(0)");
    expect(source).toContain('nextGlobalSnapshot = await readSnapshot("global")');
    expect(source).not.toContain('nextScope === "project" && !globalSnapshot');
    expect(source).toContain("if (!isCurrentRequest()) return;");
  });

  /**
   * 回归：`autoEnableCodemode` 是 mcp.json 的**全局**顶层字段，pi 的语义是
   * 「项目级覆盖全局」（config.js:112）。项目级保存时若把它一起提交，会在项目文件里
   * 钉一份当前全局值的副本；之后用户改全局设置时，这份陈旧副本会反向盖掉新值。
   */
  it("autoEnableCodemode 只在全局作用域提交", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain('...(scope === "global" ? { autoEnableCodemode } : {})');
    expect(source).not.toContain("{ servers, autoEnableCodemode }");
  });

  /**
   * 回归：列表 key 曾用 `draft.name`，而改名会实时改 name → key 变 → React 卸载重建
   * 整个条目，展开状态下改了一半的表单输入会丢。现在 key 用不随改名变化的稳定 id。
   */
  it("列表 key 与字段更新都按稳定 id，而不是 name", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain("key={draft.id}");
    expect(source).not.toContain("key={draft.name}");
    // 字段更新也必须按 id：改名瞬间 name 已经变了，按 name 会漏掉正在编辑的条目。
    expect(source).not.toMatch(/setConfigField\(draft\.name/);
    expect(source).not.toMatch(/setDraftField\(draft\.name/);
    expect(source).toContain("setConfigField(draft.id,");
    expect(source).toContain("setDraftField(draft.id,");
  });

  it("展开状态记在 editingId 上，不是 name", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain("const [editingId, setEditingId] = useState<string | null>(null)");
    expect(source).not.toContain("editingName");
  });

  it("DraftEntry 声明了稳定 id，且 handleRename 不改它", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toMatch(/type DraftEntry = \{[\s\S]*?\bid: string;/);
    // 改名只改 name：同时改 id 会触发重挂载，等于把问题换个地方。
    expect(source).toContain("(item.id === id ? { ...item, name: next } : item)");
  });

  /** 覆盖条目的 exposure 常常是 undefined，生效的是全局同名 server 的值。 */
  it("hasCodemodeExposure 用合并后的有效 exposure", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain("resolveEffectiveExposure(entry, globalSnapshot?.servers || [])");
    expect(source).toContain("isServerEnabled(entry)");
    // 不能只看自己的 exposure（那样覆盖条目会被算成 direct，提示就漏了）。
    expect(source).not.toContain('(entry.config.exposure || "direct") === "codemode"');
  });

  it("handleAdd 里那个两个分支都返回空串的三元已被清理", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).not.toContain('kind === "override" ? "" : ""');
  });

  /**
   * 回归：pi 里没写 exposure 的 server 是 `codemode`（`config.exposure ?? "codemode"`），
   * 不是 `direct`。表单缺省显示 `direct` 会让用户以为工具直接暴露给模型。
   * 旧别名 `codemode-deferred` 也必须按归一后的名字显示，否则 select 的 value 落在一组
   * option 之外、界面空白。
   */
  it("exposure 的缺省显示值是 pi 的默认档，且旧别名先归一", () => {
    const source = readWorkspaceFile(MCP_MODAL);
    expect(source).toContain("DEFAULT_MCP_EXPOSURE");
    expect(source).toContain("resolveExposureAlias");
    expect(source).not.toContain('exposure || "direct"');
    // 三个分支的 select 都走同一个格式化函数。
    expect(source.match(/value=\{exposureFormValue\(/g)?.length).toBe(3);
  });
});
