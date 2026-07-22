export const PATH_ATTACHMENT_DRAG_MIME = "application/x-hpp-path-attachment";

export type PathAttachmentDragData = {
  name: string;
  path: string;
  kind: "file" | "folder";
};

export function writePathAttachmentDragData(
  dataTransfer: DataTransfer,
  data: PathAttachmentDragData,
): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(PATH_ATTACHMENT_DRAG_MIME, JSON.stringify(data));
  dataTransfer.setData("text/plain", data.path);
}
