import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildShellEnvironmentContract,
  detectShellFamily,
  POWERSHELL_UTF8_COMMAND_PREFIX,
  rewritePowerShellPackageManagerCommand,
  validateShellCommand,
} from "./shell-environment.mjs";

describe("Pi shell environment constraints", () => {
  it("detects common configured shell families", () => {
    expect(detectShellFamily("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("bash");
    expect(detectShellFamily("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
    expect(detectShellFamily("/bin/zsh")).toBe("posix");
    expect(detectShellFamily("cmd.exe")).toBe("cmd");
  });

  it("describes Windows Git Bash without inviting shell probing", () => {
    const contract = buildShellEnvironmentContract({
      platform: "win32",
      cwd: "C:\\Project\\Hpp",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      shellFamily: "bash",
    });
    expect(contract).toContain("Operating system: Windows (win32)");
    expect(contract).toContain("Prefer project-relative paths");
    expect(contract).toContain("do not use cmd built-ins such as del");
    expect(contract).toContain("/c/work/file");
    expect(contract).toContain("schema name is bash is registered and available");
  });

  it("describes an unavailable shell without claiming bash can execute commands", () => {
    const contract = buildShellEnvironmentContract({
      platform: "win32",
      cwd: "C:\\Project\\Hpp",
      shellPath: "missing-shell.exe",
      shellFamily: "unknown",
      shellAvailable: false,
    });
    expect(contract).toContain("Command execution is unavailable");
    expect(contract).not.toContain("schema name is bash is registered and available");
  });

  it("normalizes package-manager command positions for Windows PowerShell", () => {
    expect(rewritePowerShellPackageManagerCommand("npm run build")).toBe("npm.cmd run build");
    expect(rewritePowerShellPackageManagerCommand("  npm run build")).toBe("  npm.cmd run build");
    expect(rewritePowerShellPackageManagerCommand("npm run lint; npx tsc --noEmit && pnpm test || yarn build"))
      .toBe("npm.cmd run lint; npx.cmd tsc --noEmit && pnpm.cmd test || yarn.cmd build");
    expect(rewritePowerShellPackageManagerCommand("& npm run build\n{ npx tsc --noEmit }")).toBe("& npm.cmd run build\n{ npx.cmd tsc --noEmit }");
    expect(rewritePowerShellPackageManagerCommand("Write-Output npm; npm.cmd run build; npm.ps1 test"))
      .toBe("Write-Output npm; npm.cmd run build; npm.ps1 test");
  });

  it("provides a quiet UTF-8 PowerShell command prefix", () => {
    expect(POWERSHELL_UTF8_COMMAND_PREFIX).toContain("[Console]::OutputEncoding");
    expect(POWERSHELL_UTF8_COMMAND_PREFIX).toContain("$OutputEncoding");
    expect(POWERSHELL_UTF8_COMMAND_PREFIX).toContain("chcp.com 65001 > $null");
  });

  it.skipIf(process.platform !== "win32")("executes package-manager commands and Chinese output in real Windows PowerShell", () => {
    const powershellPath = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const command = [
      POWERSHELL_UTF8_COMMAND_PREFIX,
      "Write-Output '中文标准输出'",
      "[Console]::Error.WriteLine('中文错误输出')",
      rewritePowerShellPackageManagerCommand("npm --version"),
    ].join("; ");
    const result = spawnSync(powershellPath, ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("中文标准输出");
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(result.stderr).toContain("中文错误输出");
    expect(`${result.stdout}${result.stderr}`).not.toContain("�");
  });

  it("blocks incompatible commands before permission approval", () => {
    const environment = { platform: "win32", shellFamily: "bash" };
    expect(validateShellCommand({ ...environment, command: "del permission-test.txt" })).toContain("POSIX Shell");
    expect(validateShellCommand({ ...environment, command: "rm C:\\Project\\Hpp\\permission-test.txt" })).toContain("/c/...");
    expect(validateShellCommand({ ...environment, command: "rm permission-test.txt" })).toBeNull();
    expect(validateShellCommand({ ...environment, command: "rm '/c/Project/Hpp/permission-test.txt'" })).toBeNull();
  });

  it("allows an explicitly invoked Windows shell inside Bash", () => {
    expect(validateShellCommand({
      platform: "win32",
      shellFamily: "bash",
      command: "powershell.exe -NoProfile -Command \"Remove-Item 'C:\\Project\\Hpp\\file.txt'\"",
    })).toBeNull();
  });
});
