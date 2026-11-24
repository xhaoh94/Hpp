import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** dev 的 userData 落在正式版 userData 下的这个子目录里。 */
export const DEV_USER_DATA_DIR_NAME = "dev";

/** `hpp-data` 的业务数据目录名（settings / 会话 / Pi SDK runtime …）。 */
const HPP_DATA_DIR_NAME = "hpp-data";

/**
 * dev 模式该用的 userData 目录。
 *
 * 正式版与 dev 默认共用同一个 userData（Windows 上是 `%APPDATA%/hpp`），而
 * Electron 的两样东西都绑在 userData 上：
 *  - 单实例锁（`app.requestSingleInstanceLock()`），
 *  - Chromium profile（LocalStorage / Cookies / LevelDB / cache）。
 * 共用时正式版开着再起 dev，dev 会被判成「第二个实例」直接 `app.quit()`，
 * 于是「正式版里迭代完 → 起 dev 验收」永远起不来；反过来 dev 开着也会挡住
 * 正式版。两个进程同时读写同一份 profile 还会撞 LevelDB 的 LOCK。
 *
 * 所以 dev 改用 `<正式版 userData>/dev`：锁和 profile 都独立，两边可以同时开，
 * 各自的单实例语义也保留（dev 之间仍然互斥）。
 *
 * 需要用自定义目录时设置 `HPP_DEV_USER_DATA`。
 */
export function resolveDevUserDataDir(packagedUserDataDir: string, override?: string | null): string {
  const custom = String(override ?? "").trim();
  return custom || join(packagedUserDataDir, DEV_USER_DATA_DIR_NAME);
}

export type SharedDataDirLinkResult = "linked" | "skipped" | "failed";

/**
 * 把 dev 的 `hpp-data` 链回正式版那一份。
 *
 * 数据目录里放着 settings.json、会话 store、Pi SDK runtime、worktrees 等，
 * 全都按 `userData/hpp-data` 定位；不共享的话 dev 首次启动是个空环境，
 * 要重新装 SDK、重配 provider 才能跑 agent。这里用一个目录链接把两边接上：
 * 链接对上层完全透明，业务数据一致，Chromium profile 和单实例锁仍是独立的。
 *
 * 已经存在（真实目录或早先创建的链接）就原样保留，绝不删除用户数据。
 * 链接失败（权限 / 跨卷）时返回 "failed"，调用方退回独立数据目录。
 */
export function ensureSharedDataDirLink(
  sharedDataDir: string,
  devDataDir: string,
): SharedDataDirLinkResult {
  try {
    lstatSync(devDataDir);
    return "skipped";
  } catch {
    // 不存在才需要建链接。
  }
  try {
    mkdirSync(sharedDataDir, { recursive: true });
    // Windows 上 junction 不需要管理员权限；POSIX 侧用普通目录软链。
    symlinkSync(sharedDataDir, devDataDir, process.platform === "win32" ? "junction" : "dir");
    return "linked";
  } catch {
    return "failed";
  }
}

/** dev 模式下的业务数据目录（`<devUserData>/hpp-data`）。 */
export function resolveDevDataDir(devUserDataDir: string): string {
  return join(devUserDataDir, HPP_DATA_DIR_NAME);
}

/** 正式版的业务数据目录（`<packagedUserData>/hpp-data`），dev 要链接的目标。 */
export function resolvePackagedDataDir(packagedUserDataDir: string): string {
  return join(packagedUserDataDir, HPP_DATA_DIR_NAME);
}