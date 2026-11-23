import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Git workspace modal", () => {
  it("uses the main-process Git API for status, diff, staging, commit and stash", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    expect(source).toContain("gitStatus(target.path)");
    expect(source).toContain("gitDiff(target.path");
    expect(source).toContain("gitStage(target.path");
    expect(source).toContain("gitUnstage(target.path");
    expect(source).toContain("gitDiscard(target.path");
    expect(source).toContain("gitCommit(target.path");
    expect(source).toContain("gitStashCreate(target.path");
    expect(source).toContain("gitStashList(target.path");
    expect(source).toContain("gitStashPop(target.path");
    // 「修改上次提交」= git commit --amend（本地改写），推送是独立开关
    expect(source).toContain("pushAfterCommit");
    expect(source).toContain("gitPush(target.path)");
  });

  it("embeds the project tree with its own context menu", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    const tree = read("src/components/git/GitFileTree.tsx");
    const menu = read("src/components/git/GitTreeMenu.tsx");
    expect(source).toContain("<GitFileTree");
    expect(source).toContain("<GitTreeMenu");
    expect(tree).toContain("onContextMenu");
    expect(tree).toContain("readDirectory");
    expect(menu).toContain("添加到「待提交」");
    // 树里的操作必须走仓库相对路径
    expect(source).toContain("gitDiscard(target.path, [relativePath])");
    expect(source).toContain("<GitBlamePanel");
    expect(read("src/components/git/GitBlamePanel.tsx")).toContain("electronAPI?.gitBlame");
    expect(source).toContain("stage([treeMenu.relativePath])");
  });

  it("uses one selection key for both the rows and the diff lookup", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    // 行里曾经写死 `${path}:unstaged`，查询用 `${path}:${stagedView}`（= :true/:false），
    // 选中永远匹配不上，右侧 diff 一直是空的。
    expect(source).toContain("const changeKey = (item: ChangeItem)");
    expect(source).toContain("items.find((item) => changeKey(item) === selectedKey)");
    expect(source).not.toContain("${item.path}:unstaged");
    expect(source).not.toContain("${item.path}:staged");
  });

  it("is a wide standalone modal that fills the viewport instead of a fixed max width", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    const styles = read("src/components/git/GitWorkspaceModal.css");
    const rule = (selector: string) => {
      const start = styles.indexOf(`${selector} {`);
      return start < 0 ? "" : styles.slice(start, styles.indexOf("}", start));
    };
    expect(source).toContain('className="git-workspace-overlay"');
    expect(source).toContain("className={`git-workspace-modal ");

    const modal = rule(".git-workspace-modal");
    expect(modal).toContain("width: 100%");
    expect(modal).toContain("height: 100%");
    // 不要写死 px 上限：窗口尺寸跟着视口走
    expect(modal).not.toContain("min(");
    expect(rule(".git-workspace-body")).toContain("grid-template-columns: clamp(");
  });

  it("offers removing a tracked path from the index before ignoring it", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    const menu = read("src/components/git/GitTreeMenu.tsx");
    // 菜单项：已跟踪的路径只写 .gitignore 不生效，必须给「移除」入口
    expect(menu).toContain("从版本库移除此目录…");
    expect(menu).toContain("从版本库移除此文件…");
    expect(menu).toContain("onUntrack");
    // 先 git rm --cached 再写忽略：顺序反了 .gitignore 对已跟踪路径不生效
    const untrackAt = source.indexOf("const untrackTreePath");
    const removeAt = source.indexOf("gitUntrackPath(target.path, relativePath)", untrackAt);
    const ignoreAt = source.indexOf("gitIgnorePath(target.path, relativePath)", untrackAt);
    expect(untrackAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(untrackAt);
    expect(ignoreAt).toBeGreaterThan(removeAt);
    // 会把删除放进待提交，必须二次确认并说清本地文件保留
    expect(source).toContain("本地文件会保留");
    expect(source).toContain('confirmLabel: "移除并忽略"');
  });

  it("offers a confirmed force-delete when Git refuses to delete an unmerged branch", () => {
    const source = read("src/components/git/GitWorkspaceModal.tsx");
    expect(source).toContain("gitDeleteBranch(target.path, branch.name, force)");
    expect(source).toMatch(/not fully merged|not merged|未合并/);
    expect(source).toContain('label: "强制删除"');
    // 强制删除必须二次确认，且提示会丢未合并改动。
    expect(source).toContain("未合并的改动会丢失");
    expect(source).toContain('title: force ? "强制删除分支" : "删除分支"');
  });
});
