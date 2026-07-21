export function calculateVisibleAgentCount(
  buttonWidths: number[],
  availableWidth: number,
  moreButtonWidth: number,
  gap: number,
): number {
  if (buttonWidths.length === 0 || availableWidth <= 0) return 0;
  const normalizedGap = Math.max(0, gap);
  const totalWidth = buttonWidths.reduce((total, width) => total + Math.max(0, width), 0)
    + normalizedGap * Math.max(0, buttonWidths.length - 1);
  if (totalWidth <= availableWidth) return buttonWidths.length;

  let usedWidth = Math.max(0, moreButtonWidth);
  let visibleCount = 0;
  for (const width of buttonWidths) {
    const nextWidth = usedWidth + normalizedGap + Math.max(0, width);
    if (nextWidth > availableWidth) break;
    usedWidth = nextWidth;
    visibleCount += 1;
  }
  return visibleCount;
}
