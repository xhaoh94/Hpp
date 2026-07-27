import { describe, expect, it } from "vitest";
import {
  buildShellEnvironmentContract,
  detectShellFamily,
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
