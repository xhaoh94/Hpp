import { lazy, Suspense } from "react";
import type { CodeReviewDialogProps } from "./CodeReviewDialog";

const CodeReviewDialogImpl = lazy(() => import("./CodeReviewDialog").then((module) => ({
  default: module.CodeReviewDialog,
})));

/** 审核弹窗只在用户点击“审核”时加载，避免 Diff 组件把大块高亮逻辑带入首屏。 */
export function LazyCodeReviewDialog(props: CodeReviewDialogProps) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <CodeReviewDialogImpl {...props} />
    </Suspense>
  );
}
