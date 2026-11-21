import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => testState.userDataDir },
}));

import { decryptLocalSecret, encryptLocalSecret, isLocalSecretCiphertext } from "./local-secret";

const keyPath = () => join(testState.userDataDir, "hpp-data", "secret.key");

beforeEach(async () => {
  testState.userDataDir = await mkdtemp(join(tmpdir(), "hpp-local-secret-"));
});

afterEach(async () => {
  await rm(testState.userDataDir, { recursive: true, force: true });
});

describe("本地密钥加密", () => {
  it("可往返解密，密文不含明文", () => {
    const cipher = encryptLocalSecret("super-secret-token");
    expect(cipher).toBeDefined();
    expect(isLocalSecretCiphertext(cipher!)).toBe(true);
    expect(cipher).not.toContain("super-secret-token");
    expect(decryptLocalSecret(cipher!)).toBe("super-secret-token");
  });

  it("密钥文件权限为 0600（POSIX）", async () => {
    if (process.platform === "win32") return;
    expect(encryptLocalSecret("value")).toBeDefined();
    const info = await stat(keyPath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("篡改密文后无法解密", () => {
    const cipher = encryptLocalSecret("value")!;
    const tampered = `${cipher.slice(0, -2)}AA`;
    expect(decryptLocalSecret(tampered)).toBeUndefined();
  });

  it("密钥文件损坏时保留原文件，不生成新密钥覆盖", async () => {
    await mkdir(join(testState.userDataDir, "hpp-data"), { recursive: true });
    await writeFile(keyPath(), "short");
    expect(encryptLocalSecret("value")).toBeUndefined();
    expect(await readFile(keyPath(), "utf8")).toBe("short");
  });
});
