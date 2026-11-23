import { describe, expect, it } from "vitest";
import composerSource from "./ChatComposer.tsx?raw";

/** 只取键盘处理函数那一段，避免整份源码里同名字符串误命中。 */
const keydownHandler = (() => {
  const start = composerSource.indexOf("const handleEditorKeyDown");
  const end = composerSource.indexOf("const handleChooseFiles");
  return start >= 0 && end > start ? composerSource.slice(start, end) : "";
})();

/** `/` 触发那一段：从注释到 Ctrl/Cmd+Enter 分支之前。 */
const slashTrigger = keydownHandler.slice(
  keydownHandler.indexOf("CLI 习惯"),
  keydownHandler.indexOf("Ctrl/Cmd+Enter"),
);

const clearSlashTriggerSource = composerSource.slice(
  composerSource.indexOf("const clearSlashTrigger"),
  composerSource.indexOf("const handleSelectAction"),
);

describe("聊天输入框的 / 技能快捷键", () => {
  it("空输入框里输入 / 会打开技能面板，斜杠本身留在正文", () => {
    expect(slashTrigger).toContain('event.key === "/"');
    expect(slashTrigger).toContain("openActionPicker(true)");
    // 斜杠是用户输入的一部分：不能吞掉默认插入，否则正文里看不到 /。
    expect(slashTrigger).not.toContain("preventDefault");
    expect(slashTrigger).not.toContain("stopPropagation");
    // 面板要等这一帧把 / 插进正文后再打开，否则字符会落进搜索框。
    expect(slashTrigger).toContain("requestAnimationFrame(() => openActionPicker(true))");
    expect(slashTrigger).toContain("slashInsertedRef.current = true;");
  });

  it("只在整段为空、且当前 Agent 有技能目录时触发", () => {
    // 正文里的路径（src/main.ts）、日期（11/23）不能被当成命令吞掉。
    expect(slashTrigger).toContain("!composerDocumentHasContent(composerDocument)");
    expect(slashTrigger).toContain("&& actionSupported");
  });

  it("选中技能后把正文里的 / 删掉，再挂上技能", () => {
    // 只有「/ 触发」才删；按钮打开面板时正文跟面板无关。
    expect(clearSlashTriggerSource).toContain("if (!slashInsertedRef.current) return;");
    expect(clearSlashTriggerSource).toContain("onDocumentChange(createComposerDocument([]))");
    // 只清理确实只剩一个 `/` 的文档，避免误删用户内容。
    expect(clearSlashTriggerSource).toContain('only.text === "/"');
    expect(composerSource).toContain("clearSlashTrigger();\n    onSelectAction(");
  });

  it("直接关掉面板时保留 /，相当于用户输入了普通字符", () => {
    // Esc / X / 点到别处：只清标记，绝不动正文。
    expect(composerSource).toContain("if (wasPickerOpen) slashInsertedRef.current = false;");
    const escapeStart = composerSource.indexOf('if (event.key === "Escape")');
    const escapeBlock = composerSource.slice(
      escapeStart,
      composerSource.indexOf('document.addEventListener("mousedown"', escapeStart),
    );
    expect(escapeBlock).not.toContain("createComposerDocument");
    // 出口要写在界面上，用户才找得到。
    expect(composerSource).toContain("直接关闭则保留 / 继续输入");
  });

  it("打开后直接打字就能过滤，Esc 关闭并把焦点还给输入框", () => {
    // 搜索框自动聚焦：按 / 之后接着敲的字直接进过滤，不用再点一下。
    expect(composerSource).toContain("autoFocus");
    expect(composerSource).toContain(
      "if (wasPickerOpen) requestAnimationFrame(() => editorRef.current?.focus());",
    );
    // 每次打开都清掉上次的搜索词，否则 / 之后只剩上一轮的结果。
    expect(composerSource).toContain('setActionSearch("")');
  });

  it("搜索框里可以用 ↑↓ 移动、Enter 选中", () => {
    expect(composerSource).toContain('event.key === "ArrowDown" || event.key === "ArrowUp"');
    expect(composerSource).toContain("const entry = orderedActions[actionActiveIndex];");
    // 高亮项要能跟着键盘走进可视区。
    expect(composerSource).toContain('querySelector<HTMLElement>(".chat-action-item.active")');
  });
});
