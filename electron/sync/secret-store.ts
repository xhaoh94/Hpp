import { safeStorage } from "electron";
import type { ChannelSyncSecretStorageStatus } from "../../shared/channel-sync";
import { decryptLocalSecret, encryptLocalSecret, isLocalSecretCiphertext } from "./local-secret";

/**
 * SSH 密码 / 服务 Token 的落盘加密。
 *
 * 优先用 Electron 的 safeStorage（Windows 上是 DPAPI，绑定当前用户）。系统
 * 没有可用后端（某些 Linux 无 keyring）时，可以显式降级到 Hpp 本地密钥：
 * 密文带 `hpp-local:v1:` 前缀，`decryptSecret` 按前缀自动选择解密方式。
 * 不提供明文落盘路径。
 */

export interface EncryptSecretOptions {
  /**
   * 系统安全存储不可用时，是否允许用 Hpp 本地密钥加密。
   *
   * 应用生成的 Token 默认允许；SSH 密码只在用户显式勾选后才允许。
   */
  allowLocalFallback?: boolean;
}

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptSecret(
  value: string,
  options: EncryptSecretOptions = {},
): string | undefined {
  const trimmed = (value || "").trim();
  if (!trimmed) return undefined;
  if (isSecretStorageAvailable()) {
    try {
      return safeStorage.encryptString(trimmed).toString("base64");
    } catch {
      // 系统后端异常：只有调用方明确允许时才降级到本地密钥。
      if (!options.allowLocalFallback) return undefined;
    }
  }
  return options.allowLocalFallback ? encryptLocalSecret(trimmed) : undefined;
}

export function getSecretStorageStatus(): ChannelSyncSecretStorageStatus {
  let backend = "unknown";
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch {
    // 非 Linux 平台或旧版 Electron 没有这个接口：状态里保留 unknown。
  }
  return { available: isSecretStorageAvailable(), backend };
}

export function decryptSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (isLocalSecretCiphertext(value)) return decryptLocalSecret(value);
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return undefined;
  }
}
