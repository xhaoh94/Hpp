import { MESSAGE_WRAPPER_TAG, stripInternalTags } from "./message-internal-tags";

export type UserMessageAttachment = {
  kind: "file" | "folder" | "image";
  label: string;
};

const USER_MESSAGE_ATTACHMENT_PATTERN =
  /\[(file|folder):\s*([^\]\r\n]+)\]|\[image:\s*([^\]\r\n]+)\]|\[([^\[\]\r\n:]+):([1-9]\d*)-([1-9]\d*)\]/g;

export function extractUserMessageAttachments(content: string): {
  text: string;
  attachments: UserMessageAttachment[];
} {
  const attachments: UserMessageAttachment[] = [];
  // 历史消息可能只留下发给 Agent 的裸 content（信封 XML）：旧版本没有分开
  // 保存 displayContent/sendContent，分叉与重发也会把 sendContent 写回正文。
  // 先规范成展示标签再提取附件，气泡才不会把 `<folder path=… />` 当正文显示。
  const normalizedContent = stripInternalTags(String(content || "")).replace(MESSAGE_WRAPPER_TAG, "");
  const textWithoutAttachments = normalizedContent.replace(
    USER_MESSAGE_ATTACHMENT_PATTERN,
    (match, pathKind: string | undefined, pathLabel: string | undefined,
      imageName: string | undefined,
      fileName: string | undefined, startLine: string | undefined, endLine: string | undefined) => {
      if (pathKind && pathLabel) {
        attachments.push({ kind: pathKind as "file" | "folder", label: pathLabel.trim() });
        return "";
      }

      // 图片本身由消息的 images 渲染成缩略图；这里只把标签从正文里取出，
      // 没有缩略图数据时渲染侧会退回显示一个图片芯片。
      if (imageName) {
        attachments.push({ kind: "image", label: imageName.trim() });
        return "";
      }

      if (fileName && startLine && endLine && Number(startLine) <= Number(endLine)) {
        attachments.push({ kind: "file", label: `${fileName.trim()}:${startLine}-${endLine}` });
        return "";
      }

      return match;
    },
  );

  const lines = textWithoutAttachments.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();

  return {
    text: lines.map((line) => line.replace(/[ \t]+$/g, "")).join("\n"),
    attachments,
  };
}
