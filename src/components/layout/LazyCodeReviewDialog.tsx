import { lazy, Suspense } from "react";
import type { CodeReviewDialogProps } from "./CodeReviewDialog";

const loadCodeReviewDialog = () => import("./CodeReviewDialog").then((module) => ({
  default: module.CodeReviewDialog,
}));

const CodeReviewDialogImpl = lazy(loadCodeReviewDialog);

let preloadRequested = false;

/**
 * 预取审核弹窗代码块。
 *
 * 该 chunk 里带着 diff 渲染与语法高亮（lowlight/highlight.js 的语言包），首次下载
 * 与解析要几百毫秒；等用户点“审核”再开始加载，弹窗会先出现壳、稍后才定位到第一个
 * 改动处。卡片渲染完成后空闲预取，点击时模块已经在缓存里，定位能和首帧一起完成。
 */
export function preloadCodeReviewDialog() {
  if (preloadRequested) return;
  preloadRequested = true;
  void loadCodeReviewDialog();
}

/** 审核弹窗只在用户点击“审核”时加载，避免 Diff 组件把大块高亮逻辑带入首屏。 */
export function LazyCodeReviewDialog(props: CodeReviewDialogProps) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <CodeReviewDialogImpl {...props} />
    </Suspense>
  );
}
