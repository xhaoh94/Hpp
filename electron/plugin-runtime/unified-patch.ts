import { createTwoFilesPatch } from "diff";

export type UnifiedFileStatus = "added" | "deleted" | "modified";

export const VALID_UNIFIED_STATUS = new Set<UnifiedFileStatus>(["added", "deleted", "modified"]);

/**
 * 上限与 session diff 保持一致：超过后放弃补丁而不是生成半成品，
 * 避免下游 git apply 拿到被截断的 hunk 而误判文件状态。
 */
export const MAX_UNIFIED_DIFF_BYTES = 20 * 1024 * 1024;

export const normalizeContent = (value: string) => value.replace(/\r\n?/g, "\n");

export const formatPatchPath = (value: string) => {
  if (!/[\s"\\]/.test(value)) return value;
  return JSON.stringify(value);
};

export const countPatchChanges = (patch: string) => ({
  additions: (patch.match(/^\+[^+]/gm) || []).length,
  deletions: (patch.match(/^-[^-]/gm) || []).length,
});

/**
 * 把任意来源的 unified patch 重写成下游（review 撤销、diff 卡片）统一消费的
 * canonical 形态：固定 diff --git / --- / +++ 头，并带上生命周期语义。
 * 没有 hunk 的补丁一律丢弃——它无法表达任何变更。
 */
export const buildCanonicalPatch = (
  file: string,
  sourcePatch: string,
  status: UnifiedFileStatus | undefined,
): string => {
  const lines = sourcePatch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const lifecycle = status === "added" || status === "deleted";
  const header = [
    `diff --git ${formatPatchPath(`a/${file}`)} ${formatPatchPath(`b/${file}`)}`,
    ...(lifecycle ? [status === "added" ? "new file mode 100644" : "deleted file mode 100644"] : []),
    `--- ${status === "added" ? "/dev/null" : formatPatchPath(`a/${file}`)}`,
    `+++ ${status === "deleted" ? "/dev/null" : formatPatchPath(`b/${file}`)}`,
  ];
  // 没有 hunk 时，只有生命周期变更（空文件的新建/删除）才是成立的补丁。
  // 撤销引擎正是靠 new/deleted file mode 还原文件的存在性，丢不得。
  if (firstHunk < 0) return lifecycle ? header.join("\n") : "";
  return [...header, ...lines.slice(firstHunk)].join("\n");
};

/**
 * 判断一份补丁是否真的表达了变更。
 *
 * - 有 hunk 且至少一行 +/- —— 真实内容变更
 * - 无 hunk 但声明了 new/deleted file mode —— 生命周期变更（空文件新建/删除）
 * - 其余（空补丁、只有上下文行的补丁）—— 无法表达任何变更
 *
 * 第三类正是「diff 卡片显示 +0 -0、审核弹窗拒绝撤销」的根源：provider 只回报
 * 了文件路径和 modified 状态却没给补丁，下游拿到空 patch 后又不敢丢弃，
 * 于是渲染出一个看似有改动、实则无法撤销的条目。
 */
export const patchDescribesChange = (patch: string | undefined | null): boolean => {
  if (typeof patch !== "string") return false;
  const trimmed = patch.trim();
  if (!trimmed) return false;
  if (/^(?:new file mode|deleted file mode)\s/m.test(trimmed)) return true;
  const hasHunk = trimmed.split("\n").some((line) => line.startsWith("@@"));
  if (!hasHunk) return false;
  return /^\+[^+]/m.test(trimmed) || /^-[^-]/m.test(trimmed);
};

/**
 * 由 before/after 全文生成 canonical unified patch。
 * before 为 null 表示文件原本不存在（新增），after 为 null 表示文件已被删除。
 */
export const createUnifiedPatch = (
  file: string,
  before: string | null,
  after: string | null,
  status?: UnifiedFileStatus,
): string => {
  const rawBefore = before ?? "";
  const rawAfter = after ?? "";
  const lifecycle = status === "added" || status === "deleted";
  // 语义比较用归一化行尾：纯行尾改写（CRLF→LF）不视为内容变更，保持既有行为。
  if (normalizeContent(rawBefore) === normalizeContent(rawAfter) && !lifecycle) return "";
  if (
    Buffer.byteLength(rawBefore, "utf8") + Buffer.byteLength(rawAfter, "utf8")
    > MAX_UNIFIED_DIFF_BYTES
  ) return "";
  // 补丁必须由「原始字节」生成：git apply 逐字节匹配上下文行（无
  // --ignore-whitespace），把 \r 洗掉的补丁应用在 CRLF 文件上必然报
  // "patch failed / patch does not apply"。jsdiff 会原样保留行内容中的
  // \r，并正确输出 "\ No newline at end of file" 标记。
  // 尾部只能去掉换行符本身（\n）——CRLF 文件补丁最后一行的 \r 是内容，
  // trimEnd 会把它当空白剥掉，最后一行从此对不上磁盘。
  const generated = createTwoFilesPatch(file, file, rawBefore, rawAfter, undefined, undefined, {
    context: 3,
  }).replace(/\n+$/, "");
  return buildCanonicalPatch(file, generated, status);
};
