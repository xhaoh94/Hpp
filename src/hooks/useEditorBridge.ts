import { useEffect } from "react";

import type { ComposerNode } from "@shared/composer-document";
import type { EditorBridgeInsertPayload, EditorBridgeInsertResult } from "@shared/editor-bridge-protocol";
import { requestComposerInsert } from "@/lib/composer-insert-event";

const getFileName = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

function toComposerNode({ request }: EditorBridgeInsertPayload): Exclude<ComposerNode, { type: "text" }> {
  if (request.kind !== "selection") {
    return {
      id: crypto.randomUUID(),
      type: "path",
      name: getFileName(request.path) || request.path,
      path: request.path,
      kind: request.kind,
    };
  }
  return {
    id: crypto.randomUUID(),
    type: "snippet",
    fileName: getFileName(request.path),
    filePath: request.path,
    startLine: request.startLine ?? 1,
    endLine: request.endLine ?? request.startLine ?? 1,
    ...(typeof request.text === "string" ? { text: request.text } : {}),
  };
}

/**
 * 外部编辑器（VSCode 扩展 / CLI）送来的选区或文件，插进当前会话的输入框。
 *
 * `requestComposerInsert` 的返回值就是"有没有会话接住"：没开会话时没有任何
 * 监听者 preventDefault，据此回报失败，客户端才拿得到真实错误。
 */
export function useEditorBridge() {
  useEffect(() => window.electronAPI.onEditorBridgeInsert((payload) => {
    const consumed = requestComposerInsert({
      node: toComposerNode(payload),
      sessionId: payload.request.sessionId,
    });
    const result: EditorBridgeInsertResult = consumed
      ? { requestId: payload.requestId, success: true }
      : { requestId: payload.requestId, success: false, error: "Hpp 当前没有打开的会话，无法插入。" };
    window.electronAPI.editorBridgeInsertResult(result);
  }), []);
}
