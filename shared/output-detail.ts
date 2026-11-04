/**
 * 输出内容详细等级。
 *
 * - `detailed`（详细，默认）：保持原有行为，完整渲染处理过程、思考与变更文件列表。
 * - `standard`（标准）：处理过程与思考照常渲染，但变更文件只显示「已修改 N 个文件」，
 *   不再逐个列出具体是哪些文件。
 * - `concise`（简洁）：只显示思考与正文输出；操作步骤、命令、变更文件等过程细节全部隐藏。
 */
export type OutputDetailLevel = "concise" | "standard" | "detailed";

export const DEFAULT_OUTPUT_DETAIL_LEVEL: OutputDetailLevel = "detailed";

export const OUTPUT_DETAIL_LEVELS: readonly OutputDetailLevel[] = ["concise", "standard", "detailed"];

export const isOutputDetailLevel = (value: unknown): value is OutputDetailLevel =>
  typeof value === "string" && (OUTPUT_DETAIL_LEVELS as readonly string[]).includes(value);

/** 读取持久化值；缺失或非法时回退到默认的「详细」。 */
export const normalizeOutputDetailLevel = (value: unknown): OutputDetailLevel =>
  isOutputDetailLevel(value) ? value : DEFAULT_OUTPUT_DETAIL_LEVEL;

/** 是否逐个列出变更的文件（只有「详细」需要）。 */
export const shouldListChangedFiles = (level: OutputDetailLevel) => level === "detailed";

/**
 * 「标准」下只显示「已修改 N 个文件」这一行摘要，不暴露文件名。
 * 没有任何变更时返回空字符串，调用方据此整行不渲染。
 */
export const formatChangedFilesSummary = (fileCount: number) =>
  (Number.isFinite(fileCount) && fileCount > 0 ? `已修改 ${Math.floor(fileCount)} 个文件` : "");

export const OUTPUT_DETAIL_LEVEL_LABELS: Record<OutputDetailLevel, string> = {
  concise: "简洁",
  standard: "标准",
  detailed: "详细",
};

export const OUTPUT_DETAIL_LEVEL_DESCRIPTIONS: Record<OutputDetailLevel, string> = {
  concise: "隐藏命令、查看文件、修改文件等操作细节",
  standard: "命令、查看文件、修改文件合并成一条摘要",
  detailed: "完整显示步骤、思考与具体变更文件",
};
