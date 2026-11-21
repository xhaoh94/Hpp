import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { app } from "electron";

/**
 * safeStorage 不可用时的本地加密兜底。
 *
 * 密钥是 32 字节随机数，落在 `hpp-data/secret.key`（0600），和密文同目录。
 * 它能跨重启解密，也能防止配置文件被单独拷走后泄露；但挡不住同一用户下的
 * 恶意进程，安全等级低于系统密钥环。因此只用于应用生成的 Token，SSH 密码
 * 需要用户显式勾选后才走这里。
 */
const LOCAL_PREFIX = "hpp-local:v1:";
const KEY_FILE = "secret.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function keyFilePath(): string {
  return join(app.getPath("userData"), "hpp-data", KEY_FILE);
}

/** 只读已有密钥；文件不存在或损坏时返回 null，绝不覆盖。 */
function readKey(path: string): Buffer | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path);
    // 文件损坏时保留原样：覆盖会永久丢掉旧密文，宁可让用户来找我们。
    if (raw.length < KEY_BYTES) return null;
    return Buffer.from(raw.subarray(0, KEY_BYTES));
  } catch {
    return null;
  }
}

/** 首次加密时生成密钥；已有文件则直接复用。 */
function ensureKey(): Buffer | null {
  const path = keyFilePath();
  if (existsSync(path)) return readKey(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    writeFileSync(path, key, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows 没有 POSIX 权限位，用户目录 ACL 负责保护。
    }
    return key;
  } catch {
    return null;
  }
}

export function isLocalSecretCiphertext(value: string): boolean {
  return value.startsWith(LOCAL_PREFIX);
}

export function encryptLocalSecret(value: string): string | undefined {
  const key = ensureKey();
  if (!key) return undefined;
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${LOCAL_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export function decryptLocalSecret(payload: string): string | undefined {
  if (!isLocalSecretCiphertext(payload)) return undefined;
  const [ivB64, tagB64, dataB64] = payload.slice(LOCAL_PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !dataB64) return undefined;
  const key = readKey(keyFilePath());
  if (!key) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}
