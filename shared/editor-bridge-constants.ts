/**
 * 编辑器桥接协议里的纯常量。
 *
 * 与 remote-constants 同理单独成文件：渲染进程只需要通道名和数值，引用这里
 * 就不会把 editor-bridge-protocol.ts 的 zod schema 打进首屏 bundle。
 */

export const EDITOR_BRIDGE_PROTOCOL_VERSION = 1 as const;

/** 只绑回环地址：这套端口不对局域网开放，和远程访问是两条独立的链路。 */
export const EDITOR_BRIDGE_HOST = "127.0.0.1";
export const EDITOR_BRIDGE_DEFAULT_PORT = 47832;
export const EDITOR_BRIDGE_DISCOVERY_FILENAME = "editor-bridge.json";

export const EDITOR_BRIDGE_SEND_PATH = "/api/v1/editor/send";
export const EDITOR_BRIDGE_STATUS_PATH = "/api/v1/editor/status";
export const EDITOR_BRIDGE_TOKEN_HEADER = "x-hpp-bridge-token";

/** 选区字面文本上限；超出的部分由客户端自行截断，改为只发路径+行号。 */
export const EDITOR_BRIDGE_MAX_TEXT_BYTES = 512 * 1024;
/** JSON 转义后体积会膨胀，请求体上限留一倍余量。 */
export const EDITOR_BRIDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 渲染层回报插入结果的最长等待；超时通常是窗口还没加载完。 */
export const EDITOR_BRIDGE_RESULT_TIMEOUT_MS = 4000;

export const EDITOR_BRIDGE_INSERT_CHANNEL = "editor-bridge:insert";
export const EDITOR_BRIDGE_RESULT_CHANNEL = "editor-bridge:insertResult";

export type EditorBridgePayloadKind = "selection" | "file" | "folder";

/** 探测/安装覆盖的编辑器；新增一家只需要在 installers 里补一条记录。 */
export const EDITOR_BRIDGE_TARGET_IDS = ["vscode", "vscodium", "cursor", "windsurf", "zed"] as const;
export type EditorBridgeTargetId = typeof EDITOR_BRIDGE_TARGET_IDS[number];

/** extension = 装 vsix；config = 写编辑器自己的配置文件（Zed 走这条）。 */
export type EditorBridgeTargetKind = "extension" | "config";
