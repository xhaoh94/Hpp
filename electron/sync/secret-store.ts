import { safeStorage } from "electron";

/**
 * SSH 密码 / 服务 Token 的落盘加密。
 *
 * 用 Electron 的 safeStorage（Windows 上是 DPAPI，绑定当前用户）。如果系统
 * 没有可用的加密后端（某些 Linux 无 keyring），加密返回 undefined：调用方
 * 必须据此拒绝保存，而不是静默写明文。
 */

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptSecret(value: string): string | undefined {
  const trimmed = (value || "").trim();
  if (!trimmed) return undefined;
  if (!isSecretStorageAvailable()) return undefined;
  try {
    return safeStorage.encryptString(trimmed).toString("base64");
  } catch {
    return undefined;
  }
}

export function decryptSecret(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return undefined;
  }
}
