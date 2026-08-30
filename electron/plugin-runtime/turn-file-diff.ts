import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
  countPatchChanges,
  createUnifiedPatch,
  normalizeContent,
  type UnifiedFileStatus,
} from "./unified-patch";

/**
 * 单个文件的快照。content 为 null 表示文件不存在（新增前 / 删除后）；
 * unsupported 表示无法安全参与 diff（目录、二进制、过大、读取失败）。
 */
type FileSnapshot =
  | { kind: "text"; content: string | null }
  | { kind: "unsupported" };

export interface ComputedFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: UnifiedFileStatus;
  statusExplicit: boolean;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const toPosix = (value: string) => value.replace(/\\/g, "/");

/**
 * 把工具事件里的路径解析成 { absolute, relative }，并拒绝越界路径。
 * 越界返回 null，避免在撤销流程里读写项目目录之外的文件。
 */
const resolveProjectFile = (
  projectPath: string,
  filePath: string,
): { absolute: string; relative: string } | null => {
  if (!projectPath || typeof filePath !== "string") return null;
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  const unified = toPosix(trimmed);
  const absolute = normalize(
    isAbsolute(unified) || /^[a-z]:\//i.test(unified) ? unified : join(projectPath, unified),
  );
  const relativePath = toPosix(relative(projectPath, absolute));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  if (/^[a-z]:\//i.test(relativePath)) return null;
  return { absolute, relative: relativePath };
};

const readSnapshot = (absolute: string): FileSnapshot => {
  try {
    if (!existsSync(absolute)) return { kind: "text", content: null };
    const info = statSync(absolute);
    if (!info.isFile()) return { kind: "unsupported" };
    if (info.size > MAX_FILE_BYTES) return { kind: "unsupported" };
    const buffer = readFileSync(absolute);
    // 含 NUL 字节视作二进制：文本 diff 会破坏其内容，撤销写回同样不安全。
    if (buffer.includes(0)) return { kind: "unsupported" };
    return { kind: "text", content: buffer.toString("utf8") };
  } catch {
    return { kind: "unsupported" };
  }
};

/**
 * 记录本轮（turn）内被文件修改类工具触碰过的文件的「修改前」内容。
 *
 * 存在的理由：部分 provider（如 OpenCode 的 edit/write）在工具结果里只回报
 * 文件路径与生命周期状态，不带 patch / before / after。此时下游拿不到任何
 * 可撤销的差异，审核弹窗只能显示 +0 -0 并拒绝撤销。这里在工具执行前抓取
 * 快照，工具结束后再读一次磁盘，自行算出真实 unified patch。
 */
export class TurnFileDiffTracker {
  private readonly baselines = new Map<string, FileSnapshot>();

  reset(): void {
    this.baselines.clear();
  }

  /**
   * tool_start 阶段调用，抓取「修改前」快照。
   * 已有快照时不覆盖，保证保留的是本轮最早观测到的状态。
   */
  capture(projectPath: string, filePath: string): void {
    const resolved = resolveProjectFile(projectPath, filePath);
    if (!resolved) return;
    if (this.baselines.has(resolved.relative)) return;
    this.baselines.set(resolved.relative, readSnapshot(resolved.absolute));
  }

  /**
   * tool_end 阶段调用，计算 baseline → 当前磁盘内容的真实差异。
   *
   * 返回 null 表示「无法安全推导」，包含三种情况：
   * - 该文件从未被 capture（例如 provider 未流式下发 pending 状态，
   *   tool_start 与 tool_end 在同一 tick 触发，快照已经是改后的内容）
   * - 文件是二进制 / 过大 / 越界
   * - baseline 与当前内容一致（确实没改动，或快照抓晚了）
   *
   * 这种情况下不要编造空 patch：下游会据此显示 +0 -0 并让撤销失败，
   * 反而不如诚实地不出 diff。
   */
  resolve(projectPath: string, filePath: string): ComputedFileDiff | null {
    const resolved = resolveProjectFile(projectPath, filePath);
    if (!resolved) return null;
    const baseline = this.baselines.get(resolved.relative);
    if (!baseline || baseline.kind === "unsupported") return null;

    const current = readSnapshot(resolved.absolute);
    if (current.kind === "unsupported") return null;

    const before = baseline.content;
    const after = current.content;
    if (before !== null && after !== null && normalizeContent(before) === normalizeContent(after)) {
      return null;
    }
    if (before === null && after === null) return null;

    const status: UnifiedFileStatus =
      before === null ? "added" : after === null ? "deleted" : "modified";
    const patch = createUnifiedPatch(resolved.relative, before, after, status);
    if (!patch) return null;

    const counts = countPatchChanges(patch);
    return {
      file: resolved.relative,
      patch,
      additions: counts.additions,
      deletions: counts.deletions,
      status,
      statusExplicit: status !== "modified",
    };
  }
}

/** 会改写文件内容的工具种类。只有它们需要抓取修改前快照。 */
const FILE_MUTATING_KINDS = new Set<string>(["write_file", "edit_file"]);

export interface ToolFileTarget {
  toolKind: string;
  filePath?: string;
}

/**
 * 供各 backend 使用的门面：tool_start 抓快照，tool_end 出兜底补丁。
 *
 * 只有 write_file / edit_file 两类工具会改写内容，read_file / list_dir /
 * run_command 等一律跳过，避免给每个工具调用都付两次磁盘读的代价。
 */
export class ToolFileDiffFallback {
  private readonly tracker = new TurnFileDiffTracker();
  /** 本轮已算出的兜底差异，按项目相对路径去重（保留最新累计快照）。 */
  private readonly resolved = new Map<string, ComputedFileDiff>();

  reset(): void {
    this.tracker.reset();
    this.resolved.clear();
  }

  /** tool_start 调用：此刻 provider 通常还没写盘，抓到的才是「修改前」。 */
  onToolStart(projectPath: string, target: ToolFileTarget): void {
    if (!FILE_MUTATING_KINDS.has(target.toolKind) || !target.filePath) return;
    this.tracker.capture(projectPath, target.filePath);
  }

  /** tool_end 调用：provider 没给可用补丁时用来自算差异。 */
  resolve(projectPath: string, target: ToolFileTarget): ComputedFileDiff | null {
    if (!FILE_MUTATING_KINDS.has(target.toolKind) || !target.filePath) return null;
    const diff = this.tracker.resolve(projectPath, target.filePath);
    if (diff) this.resolved.set(diff.file, diff);
    return diff;
  }

  /**
   * 与 provider 的权威快照合并：同一文件以自算兜底为准。
   *
   * 兜底由磁盘真实内容算出、反向应用必然成功；provider 的累计快照可能基于
   * 过期上下文而 apply 不上——那正是「审核弹窗显示无法撤销」的主要成因，
   * 而它又会因为「权威」身份盖掉兜底。兜底没覆盖到的文件（子代理改动、
   * 未被工具事件记录的变更）仍保留 provider 数据，不会因为这里丢信息。
   */
  mergeWithProviderDiffs<T extends { file: string }>(
    providerDiffs: T[],
  ): Array<T | ComputedFileDiff> {
    if (this.resolved.size === 0) return providerDiffs;
    const fallback = [...this.resolved.values()];
    const files = new Set(fallback.map((diff) => diff.file));
    return [...providerDiffs.filter((diff) => !files.has(diff.file)), ...fallback];
  }

  /**
   * 把本轮新算出的差异并入已有列表：同一文件只保留最新的一份。
   *
   * 兜底补丁是「本轮起点 → 当前磁盘」的**累计**快照；provider 也常常上报同
   * 文件的多次增量。两者都按"该文件本轮最后已知状态"取一份，绝不简单把每个
   * tool 调用的结果都堆进 activeToolDiffs——否则后续同文件 +4 的两次报告会让
   * 卡片显示成 +8，而审核 prepareFile 更会拿到一组基于过期行号的 incremental
   * patch，每份单独反向 apply 都 "patch does not apply"，最终在弹窗里抛出
   * "补丁 #4 / #3 / #2 / #1 正反向均失败"。
   *
   * 这里不区分 fallback 是否启动：去重是接口契约的一部分，否则无论兜底补没
   * 补到都会被 provider 的多份增量覆盖污染。
   */
  mergeDiffs<T extends { file: string }>(
    existing: T[],
    toolDiffs: T[],
    fallback: ComputedFileDiff | null,
  ): T[] {
    if (toolDiffs.length === 0) return existing;
    const seen = new Set<string>();
    const result: T[] = [];
    // 先把本次工具事件的相关 entry 放入（覆盖任何同文件旧条目），
    // 再把现有列表里未被覆盖的文件按原顺序补回。fallback 仅用来选择
    // "应该被本次工具事件取代" 的文件集合，避免对并发 patch 顺序做出
    // 未经保证的猜测。
    const overrideFiles = new Set<string>();
    for (const diff of toolDiffs) overrideFiles.add(diff.file);
    if (fallback) overrideFiles.add(fallback.file);
    for (const diff of toolDiffs) {
      if (seen.has(diff.file)) continue;
      seen.add(diff.file);
      result.push(diff);
    }
    for (const diff of existing) {
      if (overrideFiles.has(diff.file) || seen.has(diff.file)) continue;
      seen.add(diff.file);
      result.push(diff);
    }
    return result;
  }
}
