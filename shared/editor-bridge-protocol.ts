import { z } from "zod";

import {
  EDITOR_BRIDGE_MAX_TEXT_BYTES,
  EDITOR_BRIDGE_PROTOCOL_VERSION,
  EDITOR_BRIDGE_TARGET_IDS,
  type EditorBridgePayloadKind,
  type EditorBridgeTargetId,
  type EditorBridgeTargetKind,
} from "./editor-bridge-constants";

export * from "./editor-bridge-constants";

const pathSchema = z.string().trim().min(1).max(4096);
const lineSchema = z.number().int().positive();

/**
 * 客户端 → Hpp 的唯一请求体。`text` 是可选的字面内容：编辑器里未保存的缓冲区
 * 无法从磁盘读到正确内容，此时必须带上 text，Hpp 会用它替代读盘。
 */
export const editorBridgeSendSchema = z.object({
  version: z.literal(EDITOR_BRIDGE_PROTOCOL_VERSION).optional(),
  client: z.string().trim().min(1).max(32),
  kind: z.enum(["selection", "file", "folder"]),
  path: pathSchema,
  startLine: lineSchema.optional(),
  endLine: lineSchema.optional(),
  text: z.string().max(EDITOR_BRIDGE_MAX_TEXT_BYTES).optional(),
  language: z.string().trim().max(64).optional(),
  sessionId: z.string().trim().min(1).max(256).optional(),
  /** 默认 false：连续发送时不该把焦点从编辑器抢走。 */
  focus: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== "selection") return;
  if (value.startLine === undefined || value.endLine === undefined) {
    ctx.addIssue({ code: "custom", message: "kind=selection 必须给出 startLine/endLine。" });
    return;
  }
  if (value.endLine < value.startLine) {
    ctx.addIssue({ code: "custom", message: "endLine 不能小于 startLine。" });
  }
});

export type EditorBridgeSendRequest = z.infer<typeof editorBridgeSendSchema>;

/** Hpp 写在 userData 里的发现文件，客户端据此拿到端口和令牌。 */
export const editorBridgeDiscoverySchema = z.object({
  version: z.literal(EDITOR_BRIDGE_PROTOCOL_VERSION),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

export type EditorBridgeDiscovery = z.infer<typeof editorBridgeDiscoverySchema>;

export type EditorBridgeStatus = {
  running: boolean;
  host: string;
  port: number;
  protocolVersion: number;
  discoveryPath: string;
  error?: string;
};

export type EditorBridgeTargetInfo = {
  id: EditorBridgeTargetId;
  label: string;
  kind: EditorBridgeTargetKind;
  /** 应用本身装没装（不依赖 CLI 是否进了 PATH）。 */
  appInstalled: boolean;
  /** 可用的 CLI 绝对路径；null 表示找不到，装不了扩展。config 类编辑器恒为 null。 */
  cliPath: string | null;
  /** 已接入：vsix 装上了，或配置文件里已经有 Hpp 的条目。 */
  configured: boolean;
  /** 已安装的扩展版本；config 类编辑器恒为 null。 */
  installedVersion: string | null;
  /** Hpp 自带的 vsix 版本；缺 vsix 时为 null。 */
  bundledVersion: string | null;
};

export type EditorBridgeZedResult = {
  success: boolean;
  error?: string;
  tasksPath?: string;
  keymapPath?: string;
  /** keymap.json 已存在时不动它，改为把该加的键位回传。 */
  keymapSnippet?: string;
};

export type EditorBridgeInstallResult = {
  success: boolean;
  error?: string;
  output?: string;
};

export type EditorBridgeInsertResult = {
  requestId: string;
  success: boolean;
  error?: string;
};

export type EditorBridgeInsertPayload = {
  requestId: string;
  request: EditorBridgeSendRequest;
};

export { EDITOR_BRIDGE_TARGET_IDS, type EditorBridgePayloadKind, type EditorBridgeTargetId };
