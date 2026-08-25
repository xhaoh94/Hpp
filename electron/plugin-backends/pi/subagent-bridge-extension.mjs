import { isAbsolute, relative, resolve } from "node:path";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const QUESTION_TOOLS = new Set(["ask_user_question", "questionnaire", "question"]);
const HIGH_RISK_COMMAND_PATTERN = /(?:\brm\s+(?:-[^\s]*r|--recursive)|\bsudo\b|\b(?:chmod|chown)\b|\bgit\s+(?:push|clean|reset\s+--hard)|\b(?:curl|wget|ssh|scp|rsync)\b|\b(?:npm|pnpm|yarn|pip|cargo)\s+(?:install|add|publish)|invoke-webrequest|start-process|\bshutdown\b|\breboot\b|\btaskkill\b)/i;

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const normalizeToolName = (value) => String(value || "").trim().toLowerCase().replace(/-/g, "_");
const nonEmptyString = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeOption = (value) => {
  if (typeof value === "string") return { label: value, value };
  if (!isRecord(value)) return { label: String(value || ""), value: String(value || "") };
  const label = nonEmptyString(value.label || value.value || value.text || value.title) || "";
  return { ...value, label, value: String(value.value ?? label) };
};

const normalizeQuestions = (params) => {
  const rawQuestions = Array.isArray(params?.questions)
    ? params.questions
    : isRecord(params) && (params.question || params.prompt || params.message)
      ? [params]
      : [];
  return rawQuestions.filter(isRecord).map((raw, index) => ({
    id: nonEmptyString(raw.id) || `question-${index + 1}`,
    question: nonEmptyString(raw.question || raw.prompt || raw.title || raw.message) || "请选择答案",
    options: (Array.isArray(raw.options) ? raw.options : Array.isArray(raw.choices) ? raw.choices : [])
      .map(normalizeOption)
      .filter((option) => option.label),
    multiSelect: raw.multiSelect === true || raw.multiple === true,
  })).filter((question) => question.options.length > 0);
};

const getToolInput = (event) => isRecord(event?.input) ? event.input : {};

const getToolPaths = (event) => {
  const input = getToolInput(event);
  return [input.path, input.filePath, input.file_path, input.cwd, input.directory]
    .filter((value) => typeof value === "string" && value.trim())
    .map(String);
};

const isOutsideProject = (filePath) => {
  try {
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath);
    const projectRelativePath = relative(resolve(process.cwd()), absolutePath);
    return projectRelativePath === ".." || projectRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(projectRelativePath);
  } catch {
    return true;
  }
};

const describeTool = (event) => {
  const toolName = String(event?.toolName || "工具");
  const input = getToolInput(event);
  const detail = toolName === "bash"
    ? String(input.command || "")
    : getToolPaths(event).join("、") || JSON.stringify(input);
  return detail ? `${toolName}: ${detail}` : toolName;
};

const shouldRequestPermission = (event) => {
  const mode = process.env.HPP_PI_SUBAGENT_PERMISSION_MODE || "auto";
  if (mode === "full-access") return false;

  const toolName = normalizeToolName(event?.toolName);
  if (QUESTION_TOOLS.has(toolName)) return false;
  const outsideProject = getToolPaths(event).some(isOutsideProject);
  if (mode === "ask") return outsideProject || !READ_ONLY_TOOLS.has(toolName);
  if (outsideProject) return true;
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (toolName === "bash") return HIGH_RISK_COMMAND_PATTERN.test(String(getToolInput(event).command || ""));
  return false;
};

const makeQuestionResult = (questions, answers, cancelled = false) => ({
  cancelled,
  questions,
  answers,
});

const createQuestionTool = (name) => ({
  name,
  label: name === "questionnaire" ? "Questionnaire" : "Question",
  description: "向用户提问并等待 Hpp 返回选择结果。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      prompt: { type: "string" },
      options: { type: "array", items: { type: "object" } },
      questions: { type: "array", items: { type: "object" } },
      multiSelect: { type: "boolean" },
    },
    additionalProperties: true,
  },
  executionMode: "sequential",
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!ctx?.hasUI || typeof ctx.ui?.select !== "function") {
      return {
        content: [{ type: "text", text: "Error: UI not available" }],
        details: makeQuestionResult([], [], true),
      };
    }

    const questions = normalizeQuestions(params);
    if (questions.length === 0) {
      return {
        content: [{ type: "text", text: "Error: No question options provided" }],
        details: makeQuestionResult([], [], true),
      };
    }

    const answers = [];
    for (const question of questions) {
      const selected = await ctx.ui.select(
        `子 Agent 提问：${question.question}`,
        question.options.map((option) => option.label),
      );
      if (!selected) {
        return {
          content: [{ type: "text", text: "用户取消了提问" }],
          details: makeQuestionResult(questions, answers, true),
        };
      }
      const selectedOption = question.options.find((option) => option.label === selected);
      answers.push({
        id: question.id,
        question: question.question,
        answer: selected,
        selected: [selected],
        values: [selectedOption?.value ?? selected],
        selectedOptions: selectedOption ? [selectedOption] : [],
        multiSelect: question.multiSelect,
      });
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ cancelled: false, answers }) }],
      details: makeQuestionResult(questions, answers, false),
    };
  },
});

export default function hppSubagentBridgeExtension(pi) {
  if (!pi) return;

  pi.on("tool_call", async (event, ctx) => {
    if (!shouldRequestPermission(event)) return undefined;
    if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
      return { block: true, reason: "Hpp permission approval is unavailable" };
    }
    const approved = await ctx.ui.confirm(
      "子 Agent 请求权限",
      `允许子 Agent 执行以下操作？\n\n${describeTool(event)}`,
    );
    return approved ? undefined : { block: true, reason: "用户拒绝了该操作" };
  });

  pi.registerTool(createQuestionTool("ask_user_question"));
  pi.registerTool(createQuestionTool("question"));
  pi.registerTool(createQuestionTool("questionnaire"));
}
