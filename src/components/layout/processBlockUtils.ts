import type {
  AgentProcess,
  AgentProcessEntry,
  AgentProcessStep,
} from "@/stores/chat-store";
import {
  formatCompletedStepProgress,
  formatProcessCountSummary,
  formatStepProgress,
  formatThinkingSummary,
  uiText,
} from "@/i18n/text";

const THINKING_PREVIEW_CHAR_LIMIT = 240;
/** Approximate character count that fits in a single line of thinking preview. */
const THINKING_SINGLE_LINE_CHAR_LIMIT = 60;

/** Check whether thinking text is short enough to fit in a single line. */
export const isThinkingSingleLine = (value?: string): boolean => {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return true;
  return text.length <= THINKING_SINGLE_LINE_CHAR_LIMIT;
};

export const getThinkingPreview = (value?: string) => {
  const preview = value?.replace(/\s+/g, " ").trim();
  if (!preview) return uiText.process.thinking;
  return preview.length > THINKING_PREVIEW_CHAR_LIMIT
    ? `${preview.slice(0, THINKING_PREVIEW_CHAR_LIMIT)}...`
    : preview;
};

const SUBAGENT_TITLE_CHAR_LIMIT = 40;
// 「请独立编写行为测试」→「独立编写行为测试」：一级只留标题感，客套话不要。
const SUBAGENT_TITLE_POLITE_PREFIX = /^(?:请你帮我|麻烦你|请你|请|麻烦|帮忙|帮我)\s*/u;
// 状语（怎么做）不是标题重点：独立/分别/正在… 剥掉后再找动词。
const SUBAGENT_TITLE_ADVERBIAL = /^(?:独立|分别|并行|自行|单独|直接|进一步|尝试|正在|接着|继续|先)\s*/u;
// 范围/状态前缀（哪些、哪批）：任务名常以「全项目剩余动态红点迁移C组」开头，
// 胶囊只要「红点迁移C组」，逐个剥掉这些修饰词。只在动词锚点规则没命中时才用。
const SUBAGENT_TITLE_SCOPE_WORDS = [
  "全项目", "全部项目", "所有项目", "整个项目", "本项目", "当前项目",
  "全部", "所有", "整个", "全量", "剩余", "动态", "当前", "现有", "存量",
  "批量", "整体", "全", "各",
];
// 任务动词，长词优先匹配（避免「查看」被「查」抢先截断）。
const SUBAGENT_TITLE_VERBS = [
  "验证", "检查", "审查", "分析", "排查", "定位", "检索", "搜索", "修复", "解决",
  "实现", "编写", "撰写", "开发", "重构", "优化", "迁移", "修改", "添加", "新增",
  "删除", "移除", "创建", "构建", "总结", "整理", "梳理", "设计", "评估", "确认",
  "更新", "补充", "完善", "调整", "处理", "完成", "运行", "执行", "研究", "探索",
  "收集", "汇总", "测试", "读取", "查看", "查找", "写", "看", "查", "改", "找", "修",
].sort((a, b) => b.length - a.length);
// 核心宾语（做什么）：在宾语里找最靠后的一个，砍掉它前面的定语。
const SUBAGENT_TITLE_CORES = [
  "测试", "用例", "风险", "问题", "缺陷", "逻辑", "代码", "文件", "功能", "接口",
  "页面", "模块", "方案", "文档", "配置", "脚本", "报告", "需求", "设计", "实现",
  "迁移", "重构", "优化", "性能", "安全", "兼容", "样式", "布局", "动画", "资源",
  "函数", "方法", "属性", "数据", "状态", "流程", "路径", "错误", "异常", "日志",
  "提示", "文案", "bug", "Bug", "BUG", "API", "SDK", "UI", "CSS", "HTML",
].sort((a, b) => b.length - a.length);

/**
 * 把「独立编写行为测试」压成「编写测试」：动词 + 核心宾语，删掉状语和定语。
 * 动作句认不出时（如「全项目剩余动态红点迁移C组」），退而剥掉开头连续的范围
 * 修饰词，得到「红点迁移C组」。两种规则都不命中就原样返回，宁可不压也不削坏。
 */
const shortenSubagentTitle = (title: string): string => {
  const stripped = title.replace(SUBAGENT_TITLE_ADVERBIAL, "").trim();
  const verb = SUBAGENT_TITLE_VERBS.find((candidate) => stripped.startsWith(candidate));
  if (verb) {
    const object = stripped.slice(verb.length).trim();
    if (!object) return stripped;
    // 找最靠后、且贴近宾语末尾的核心名词（后面最多一个助词尾巴，如「…的问题」）。
    let core = "";
    let coreEnd = -1;
    for (const candidate of SUBAGENT_TITLE_CORES) {
      const at = object.lastIndexOf(candidate);
      if (at >= 0 && at + candidate.length > coreEnd && object.length - (at + candidate.length) <= 1) {
        core = candidate;
        coreEnd = at + candidate.length;
      }
    }
    return core ? `${verb}${core}` : stripped;
  }
  // 兜底：任务是名词短语（「全项目剩余动态红点迁移C组」），剥掉开头连续的范围词。
  let result = stripped;
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const word of SUBAGENT_TITLE_SCOPE_WORDS) {
      if (result.startsWith(word) && result.length - word.length >= 2) {
        result = result.slice(word.length).trim();
        peeled = true;
        break;
      }
    }
  }
  return result;
};

/**
 * 子任务标题：取 prompt 第一个分句，压成「动词 + 核心宾语」的极简标题。
 * prompt 常是一整篇指令（路径、背景、约束），直接铺开会把胶囊/页签撑爆；
 * 完整内容仍可通过 title 悬停或一级/二级展开查看。
 */
export const getSubagentTitle = (prompt?: string, fallback?: string): string => {
  const source = (prompt || fallback || "").trim();
  if (!source) return "";
  const firstClause = source.split(/[。；;，,\r\n]/, 1)[0].trim();
  const title = firstClause.replace(SUBAGENT_TITLE_POLITE_PREFIX, "").replace(/[.!?！？、:：]+$/, "").trim();
  if (!title) return source.slice(0, SUBAGENT_TITLE_CHAR_LIMIT);
  const short = shortenSubagentTitle(title);
  return short.length > SUBAGENT_TITLE_CHAR_LIMIT
    ? `${short.slice(0, SUBAGENT_TITLE_CHAR_LIMIT)}…`
    : short;
};

/**
 * 胶囊/页签/悬停卡的标题出口。
 *
 * 调度方给的 title 也要过一遍压缩：claude 的 Task 工具没有独立 title 参数，
 * description 常常是一整句（「确认 present 扩展引用并定位 pi SDK 安装」），
 * 直接信任它，胶囊就会被整句撑满 —— 极简标题就白做了。
 */
export const getSubagentDisplayTitle = (
  subagent: { title?: string; prompt?: string; label?: string },
): string => {
  const given = subagent.title?.trim();
  if (given) return getSubagentTitle(given) || given;
  return getSubagentTitle(subagent.prompt, subagent.label);
};

/**
 * 一级展开内容：prompt 的第一个分句，保留原始修饰（如「独立编写行为测试」）。
 * 胶囊/面板用 getSubagentTitle 把它压成动宾「编写测试」，两者刻意不同；
 * 这里不压缩，完整 prompt 仍走 title 悬停、细节在二级。
 */
export const getSubagentSummaryText = (prompt?: string, fallback?: string): string => {
  const source = (prompt || fallback || "").trim();
  if (!source) return "";
  // 先按分句（含换行）切，再压平空白——否则 \n 变空格后切不开「修复完成\n下一步」。
  const firstClause = source.split(/[。；;，,\r\n]/, 1)[0].replace(/\s+/g, " ").trim();
  const text = firstClause.replace(SUBAGENT_TITLE_POLITE_PREFIX, "").replace(/[.!?！？、:：]+$/, "").trim();
  if (!text) return source.slice(0, SUBAGENT_TITLE_CHAR_LIMIT);
  return text.length > SUBAGENT_TITLE_CHAR_LIMIT
    ? `${text.slice(0, SUBAGENT_TITLE_CHAR_LIMIT)}…`
    : text;
};

export const summarizeProcessEntries = (entries: AgentProcessEntry[]) => {
  if (entries.length === 0) return uiText.process.waitingEvent;

  if (entries.some((entry) => entry.state === "interrupted")) return uiText.process.interrupted;

  const toolCount = entries.filter((entry) =>
    entry.type === "tool" || entry.type === "question" || entry.type === "error" || entry.type === "subagent"
  ).length;
  const diffCount = entries.filter((entry) => entry.type === "diff").length;
  const isThinking = entries.some((entry) => entry.type === "thinking" && entry.state === "running");
  const thinkingEntry = entries.find((entry) => entry.type === "thinking" && entry.state === "running");
  const runningTool = entries.find((entry) =>
    (entry.type === "tool" || entry.type === "question" || entry.type === "subagent") && entry.state === "running"
  );

  if (isThinking && thinkingEntry) {
    return formatThinkingSummary(getThinkingPreview(thinkingEntry.detail));
  }

  if (runningTool) {
    return runningTool.title;
  }

  return formatProcessCountSummary(toolCount, diffCount, entries.length);
};

export const getStepProgressText = (steps: AgentProcessStep[]) => {
  const total = steps.length;
  if (total === 0) return "";

  const terminalIndex = steps.findIndex((step) => step.status === "failed" || step.status === "cancelled");
  if (terminalIndex >= 0) return formatStepProgress(terminalIndex + 1, total);

  const completed = Math.min(total, steps.filter((step) => step.status === "completed").length);
  return formatCompletedStepProgress(completed, total);
};

const isTerminalStepStatus = (status?: AgentProcessStep["status"]) =>
  status === "failed" || status === "cancelled";

const getStepById = (steps: AgentProcessStep[], id: string) =>
  steps.find((step) => step.id === id);

const isActiveStepStatus = (status?: AgentProcessStep["status"]) =>
  !!status && status !== "pending";

export const normalizeInferredStepsForDisplay = (
  process: AgentProcess,
  steps: AgentProcessStep[]
): AgentProcessStep[] => {
  const hasInferredSteps = process.planStepsSource === "inferred" || steps.some((step) => step.id.startsWith("inferred-"));
  if (!hasInferredSteps) return steps;

  const analyze = getStepById(steps, "inferred-analyze");
  const operate = getStepById(steps, "inferred-operate");
  const modify = getStepById(steps, "inferred-modify");
  const verify = getStepById(steps, "inferred-verify");
  const hasChangedFiles = (process.changeSummary?.filesChanged || 0) > 0;
  const hasModifyStep = !!modify || hasChangedFiles;
  const hasLaterActiveStep = [operate, modify, verify].some((step) => isActiveStepStatus(step?.status));
  const hasVerifyActiveStep = isActiveStepStatus(verify?.status);

  const analyzeStatus: AgentProcessStep["status"] =
    isTerminalStepStatus(analyze?.status)
      ? analyze!.status
      : hasLaterActiveStep
        ? "completed"
        : analyze?.status || "pending";

  let operateStatus: AgentProcessStep["status"] = "pending";
  if (isTerminalStepStatus(operate?.status)) {
    operateStatus = operate!.status;
  } else if (hasModifyStep || hasVerifyActiveStep || verify?.status === "completed") {
    operateStatus = "completed";
  } else if (operate?.status && operate.status !== "pending") {
    operateStatus = operate.status;
  }

  const modifyStatus: AgentProcessStep["status"] =
    isTerminalStepStatus(modify?.status)
      ? modify!.status
      : hasVerifyActiveStep || verify?.status === "completed" || (hasChangedFiles && !!process.endedAt)
        ? "completed"
        : modify?.status && modify.status !== "pending"
          ? modify.status
          : hasChangedFiles
            ? "running"
            : "pending";
  const hasTerminalBeforeVerify =
    isTerminalStepStatus(analyzeStatus) ||
    isTerminalStepStatus(operateStatus) ||
    (hasModifyStep && isTerminalStepStatus(modifyStatus));
  const verifyStatus: AgentProcessStep["status"] =
    verify?.status && verify.status !== "pending"
      ? verify.status
      : process.endedAt && !hasTerminalBeforeVerify
        ? "completed"
        : "pending";

  const normalizedSteps: AgentProcessStep[] = [
    { id: "inferred-analyze", title: uiText.process.inferredSteps.analyze, status: analyzeStatus },
    { id: "inferred-operate", title: uiText.process.inferredSteps.operate, status: operateStatus },
  ];
  if (hasModifyStep) {
    normalizedSteps.push({ id: "inferred-modify", title: uiText.process.inferredSteps.modify, status: modifyStatus });
  }
  normalizedSteps.push({ id: "inferred-verify", title: uiText.process.inferredSteps.verify, status: verifyStatus });
  return normalizedSteps;
};
