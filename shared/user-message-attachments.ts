export type UserMessageAttachment = {
  kind: "file" | "folder";
  label: string;
};

const USER_MESSAGE_ATTACHMENT_PATTERN =
  /\[(file|folder):\s*([^\]\r\n]+)\]|\[([^\[\]\r\n:]+):([1-9]\d*)-([1-9]\d*)\]/g;

export function extractUserMessageAttachments(content: string): {
  text: string;
  attachments: UserMessageAttachment[];
} {
  const attachments: UserMessageAttachment[] = [];
  const textWithoutAttachments = content.replace(
    USER_MESSAGE_ATTACHMENT_PATTERN,
    (match, pathKind: string | undefined, pathLabel: string | undefined,
      fileName: string | undefined, startLine: string | undefined, endLine: string | undefined) => {
      if (pathKind && pathLabel) {
        attachments.push({ kind: pathKind as "file" | "folder", label: pathLabel.trim() });
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
