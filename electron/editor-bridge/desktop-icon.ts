import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";

/**
 * Linux 下 app.getFileIcon('/usr/bin/code') 只会拿到脚本的通用图标，
 * 真正的编辑器图标藏在 .desktop 文件的 Icon= 字段里。这里把它解析出来。
 */

const DESKTOP_DIRS = () => [
  join(homedir(), ".local", "share", "applications"),
  "/usr/local/share/applications",
  "/usr/share/applications",
  "/var/lib/snapd/desktop/applications",
];

const DESKTOP_NAMES: Record<string, string[]> = {
  vscode: ["code.desktop", "code-oss.desktop"],
  vscodium: ["vscodium.desktop", "codium.desktop"],
  cursor: ["cursor.desktop"],
  windsurf: ["windsurf.desktop"],
  zed: ["zed.desktop", "dev.zed.Zed.desktop"],
};

/** 从 .desktop 文件里读 Icon= 值；只认第一个，跳过注释和空行。 */
export function parseDesktopIcon(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^icon=/i.test(trimmed)) {
      const value = trimmed.slice(5).trim();
      return value || null;
    }
  }
  return null;
}

/** 把 Icon= 的值解析成实际图标文件路径；绝对路径优先，否则查常见主题目录。 */
export function resolveIconValue(icon: string): string | null {
  if (isAbsolute(icon) && existsSync(icon)) return icon;
  // 去掉可能的扩展名后缀，Icon= 通常不写扩展名。
  const base = icon.replace(/\.(png|svg|xpm)$/i, "");
  const themeDirs = [
    join(homedir(), ".local", "share", "icons"),
    "/usr/local/share/icons",
    "/usr/share/icons",
    "/usr/share/pixmaps",
  ];
  for (const themeDir of themeDirs) {
    if (!existsSync(themeDir)) continue;
    const found = findIconInTheme(themeDir, base);
    if (found) return found;
  }
  return null;
}

function findIconInTheme(themeDir: string, base: string): string | null {
  // hicolor 是 freedesktop 标准主题；再扫其它主题目录（如 Adwaita、breeze）。
  const candidates: string[] = [];
  const hicolor = join(themeDir, "hicolor");
  if (existsSync(hicolor)) candidates.push(hicolor);
  try {
    for (const entry of readdirSync(themeDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "hicolor") candidates.push(join(themeDir, entry.name));
    }
  } catch {
    // 目录不可读就只查 hicolor。
  }
  for (const theme of candidates) {
    let sizes: string[];
    try {
      sizes = readdirSync(join(theme, "apps"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    // 大尺寸优先，菜单里更清晰。
    sizes.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    for (const size of sizes) {
      for (const ext of ["png", "svg"]) {
        const path = join(theme, "apps", size, `${base}.${ext}`);
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

/** 给 editorId 找到真实图标文件路径，Linux 用；找不到返回 null。 */
export function findDesktopIconPath(editorId: string): string | null {
  const names = DESKTOP_NAMES[editorId];
  if (!names) return null;
  for (const dir of DESKTOP_DIRS()) {
    for (const name of names) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      try {
        const icon = parseDesktopIcon(readFileSync(path, "utf8"));
        if (icon) {
          const resolved = resolveIconValue(icon);
          if (resolved) return resolved;
        }
      } catch {
        // 读失败就试下一个候选文件。
      }
    }
  }
  // snap 的 desktop 文件名常带应用名前缀（code_code.desktop 等）。
  for (const dir of DESKTOP_DIRS()) {
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".desktop")) continue;
        const namesLower = names.map((n) => n.replace(/\.desktop$/, ""));
        if (!namesLower.some((n) => entry.toLowerCase().includes(n))) continue;
        const icon = parseDesktopIcon(readFileSync(join(dir, entry), "utf8"));
        if (icon) {
          const resolved = resolveIconValue(icon);
          if (resolved) return resolved;
        }
      }
    } catch {
      // 目录不存在或无权限，跳过。
    }
  }
  return null;
}
