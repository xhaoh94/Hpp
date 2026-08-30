import {
  buildCanonicalPatch,
  countPatchChanges,
  createUnifiedPatch,
  patchDescribesChange,
  type UnifiedFileStatus,
} from "../../plugin-runtime/unified-patch";
import type { UnknownRecord } from "../../../src/types/ipc";

export interface OpenCodeSessionDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
  statusExplicit: boolean;
}

export interface NormalizedOpenCodeSessionDiffResult {
  recognized: boolean;
  diffs: OpenCodeSessionDiff[];
}

const MAX_SESSION_DIFF_BYTES = 20 * 1024 * 1024;
const VALID_STATUS = new Set(["added", "deleted", "modified"]);

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};

const decodeGitQuotedPath = (value: string) => {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const next = body[index + 1];
    if (!next) {
      bytes.push(92);
      continue;
    }
    const escaped = next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
    bytes.push(...Buffer.from(escaped, "utf8"));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
};

const decodeMojibakePath = (value: string) => {
  if (![...value].some((char) => char.charCodeAt(0) >= 0x80 && char.charCodeAt(0) <= 0xff)) return value;
  const bytes = Uint8Array.from([...value].map((char) => char.charCodeAt(0)));
  const decoded = Buffer.from(bytes).toString("utf8");
  return decoded.includes("\uFFFD") ? value : decoded;
};

const normalizeFile = (value: unknown) => {
  if (typeof value !== "string") return "";
  const dequoted = value.startsWith('"') && value.endsWith('"') ? decodeGitQuotedPath(value) : value;
  const normalized = decodeMojibakePath(dequoted).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
};

const readCount = (value: unknown) => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
};

const parseHeaderPath = (line: string, prefix: "--- " | "+++ ") => {
  if (!line.startsWith(prefix)) return "";
  const raw = line.slice(prefix.length).split("\t", 1)[0].trim();
  if (!raw) return "";
  return raw === "/dev/null" ? raw : normalizeFile(raw);
};

const nativePatchMatchesFile = (
  patch: string,
  file: string,
  status?: OpenCodeSessionDiff["status"],
) => {
  const lines = patch.split("\n");
  if (!lines.some((line) => line.startsWith("@@"))) return false;
  if (lines.filter((line) => line.startsWith("diff --git ")).length > 1) return false;
  const oldPath = parseHeaderPath(lines.find((line) => line.startsWith("--- ")) || "", "--- ");
  const newPath = parseHeaderPath(lines.find((line) => line.startsWith("+++ ")) || "", "+++ ");
  const paths = [oldPath, newPath].filter((value) => value && value !== "/dev/null");
  if (paths.length === 0 || !paths.every((value) => value === file)) return false;
  const isAddedPatch = oldPath === "/dev/null";
  const isDeletedPatch = newPath === "/dev/null";
  // /dev/null carries lifecycle semantics. Without an explicit provider
  // status, treating it as an ordinary modification could leave an added file
  // behind or recreate a deleted file during undo.
  if ((isAddedPatch || isDeletedPatch) && !status) return false;
  if (isAddedPatch && status !== "added") return false;
  if (isDeletedPatch && status !== "deleted") return false;
  return true;
};

/** 兼容旧 OpenCode 的 before/after FileDiff，并输出通用 canonical patch。 */
export function createOpenCodeUnifiedPatch(file: string, beforeValue: string, afterValue: string): string {
  return createUnifiedPatch(file, beforeValue, afterValue);
}

const normalizeOneDiff = (rawDiff: unknown): OpenCodeSessionDiff | null => {
  const diff = asRecord(rawDiff);
  const file = normalizeFile(diff.file);
  if (!file) return null;
  const explicitStatus = typeof diff.status === "string" && VALID_STATUS.has(diff.status)
    ? diff.status as UnifiedFileStatus
    : undefined;

  let sourcePatch = "";
  if (typeof diff.patch === "string" && diff.patch.trim()) {
    // provider 补丁必须原样保留字节（仅去尾随换行符）：git apply 逐字节
    // 匹配上下文行，把 \r 洗掉的补丁应用在 CRLF 文件上必然
    // "patch does not apply"。补丁对 CRLF 文件本身就会在 hunk 行尾携带
    // \r，这是内容的一部分，trimEnd 会误伤最后一行。
    sourcePatch = diff.patch.replace(/\n+$/, "");
    if (
      Buffer.byteLength(sourcePatch, "utf8") > MAX_SESSION_DIFF_BYTES
      || !nativePatchMatchesFile(sourcePatch, file, explicitStatus)
    ) {
      return null;
    }
  } else if (typeof diff.before === "string" && typeof diff.after === "string") {
    sourcePatch = createOpenCodeUnifiedPatch(file, diff.before, diff.after);
    if (!sourcePatch) return null;
  } else {
    return null;
  }

  const patch = buildCanonicalPatch(file, sourcePatch, explicitStatus);
  if (!patch) return null;
  // 只有上下文行、没有任何 +/- 的补丁表达不了变更。放行它下游就会渲染出
  // 「+0 -0」的假改动，并且撤销时空补丁无法反向应用。宁可丢弃。
  if (!patchDescribesChange(patch)) return null;

  const counts = countPatchChanges(patch);
  const lifecycleStatus = explicitStatus === "added" || explicitStatus === "deleted";
  return {
    file,
    patch,
    additions: counts.additions || readCount(diff.additions),
    deletions: counts.deletions || readCount(diff.deletions),
    status: explicitStatus || "modified",
    statusExplicit: lifecycleStatus,
  };
};

export function normalizeOpenCodeSessionDiffResult(value: unknown): NormalizedOpenCodeSessionDiffResult {
  if (!Array.isArray(value)) return { recognized: false, diffs: [] };
  if (value.length === 0) return { recognized: true, diffs: [] };
  const diffs = value.map(normalizeOneDiff).filter((diff): diff is OpenCodeSessionDiff => !!diff);
  return { recognized: diffs.length > 0, diffs };
}

export function normalizeOpenCodeSessionDiffs(value: unknown): OpenCodeSessionDiff[] {
  return normalizeOpenCodeSessionDiffResult(value).diffs;
}
