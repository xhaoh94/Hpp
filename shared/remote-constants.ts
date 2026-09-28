/**
 * 远程访问协议里的纯常量。
 *
 * 渲染进程与移动端只需要这些数值/名称。它们单独成文件，是为了让引用方
 * 不必加载 remote-protocol.ts（那里有完整的 zod schema），从而不把 zod
 * 带进首屏 bundle。
 */

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_REMOTE_PORT = 47831;
export const REMOTE_HISTORY_PAGE_SIZE = 50;
export const MAX_REMOTE_IMAGES = 4;
export const MAX_REMOTE_SESSION_REFERENCES = 8;
export const MAX_REMOTE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_REMOTE_REQUEST_BYTES = 8 * 1024 * 1024;

export const REMOTE_REQUEST_NAMES = [
  "catalog.get",
  "session.get",
  "session.create",
  "session.fork",
  "session.close",
  "session.reopen",
  "session.send",
  "session.abort",
  "session.reload",
  "session.queue.guide",
  "session.queue.edit",
  "session.queue.reorder",
  "session.queue.remove",
  "session.setModel",
  "session.setThinking",
  "session.models.get",
  "session.actions.get",
  "settings.setPlanMode",
  "settings.setPermissionMode",
  "interaction.respond",
] as const;

export const REMOTE_EVENT_NAMES = [
  "catalog.updated",
  "session.message.upsert",
  "session.messages.replace",
  "session.runtime.updated",
  "session.queue.updated",
  "session.interaction.updated",
  "session.config.updated",
] as const;

export type RemoteRequestName = typeof REMOTE_REQUEST_NAMES[number];
export type RemoteEventName = typeof REMOTE_EVENT_NAMES[number];
