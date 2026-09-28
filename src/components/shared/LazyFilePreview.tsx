import { lazy, Suspense } from "react";

const FilePreviewImpl = lazy(() => import("./FilePreview").then((module) => ({
  default: module.FilePreview,
})));

type LazyFilePreviewProps = {
  filePath: string | null;
  onClose: () => void;
};

/** 文件预览只在真正打开文件时加载，避免把 highlight.js/Markdown 预览带入首屏。 */
export function LazyFilePreview({ filePath, onClose }: LazyFilePreviewProps) {
  if (!filePath) return null;
  return (
    <Suspense fallback={null}>
      <FilePreviewImpl filePath={filePath} onClose={onClose} />
    </Suspense>
  );
}
