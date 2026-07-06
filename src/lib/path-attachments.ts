export const PATH_ATTACHMENT_DRAG_MIME = "application/x-hpp-path-attachment";

export type PathAttachmentDragData = {
  name: string;
  path: string;
  kind: "file" | "folder";
};
