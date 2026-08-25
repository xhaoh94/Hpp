export function resolvePreviousUserTargetIndex(
  speechIndexes: readonly number[],
  visibleSpeechIndex: number | null,
  viewportMessageIndex: number | null,
): number | null {
  const boundaryIndex = visibleSpeechIndex ?? viewportMessageIndex;
  if (boundaryIndex === null || boundaryIndex < 0) return null;

  // 视口内已有用户气泡时，按钮应继续向前跳一条；否则返回当前视口
  // 上方最近的用户发言（在对话底部时就是最后一条用户发言）。
  const includeBoundary = visibleSpeechIndex === null;
  for (let index = speechIndexes.length - 1; index >= 0; index -= 1) {
    const speechIndex = speechIndexes[index];
    if (includeBoundary ? speechIndex <= boundaryIndex : speechIndex < boundaryIndex) {
      return speechIndex;
    }
  }
  return null;
}
