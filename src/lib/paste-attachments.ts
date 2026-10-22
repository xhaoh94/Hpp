/**
 * 粘贴附件的分流。
 *
 * 输入框粘贴现在只处理图片（转 base64 附件）；复制一个视频文件粘贴时，
 * 剪贴板给出的是 `kind === "file"` 的 ClipboardItem，应当和拖拽一样走
 * 「路径附件」：不读入内存、不复制，只把磁盘路径附给消息。
 *
 * 这里保持纯函数，方便单测覆盖「图片 / 其它文件」的分流规则。
 */
export function partitionPastedFiles<T>(
  files: readonly T[],
  isImageFile: (file: T) => boolean,
): { imageFiles: T[]; otherFiles: T[] } {
  const imageFiles: T[] = [];
  const otherFiles: T[] = [];
  for (const file of files) {
    (isImageFile(file) ? imageFiles : otherFiles).push(file);
  }
  return { imageFiles, otherFiles };
}

/** 从剪贴板 items 里取出所有文件（图片和视频都会是 kind=file）。 */
export function readClipboardFiles(
  items: ArrayLike<{ kind: string; getAsFile: () => File | null }>,
): File[] {
  const files: File[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}
