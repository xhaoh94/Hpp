export type AttachmentKind = "file" | "folder" | string;
export type ProcessFileAction = "read" | "listed" | "written" | "edited" | "modified" | undefined;
export type ProcessStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type CommandState = "running" | "completed" | "error" | "interrupted" | undefined;
export type ToolSummaryKind =
  | "read_file"
  | "list_dir"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "search_files"
  | "search_text"
  | "web_fetch"
  | "web_search"
  | "question"
  | "unknown";

export const uiText = {
  chatComposer: {
    creatingFork: "正在创建分叉会话",
    creatingForkWithEllipsis: "正在创建分叉会话...",
    submitQuestionnaire: "请在上方提交问卷",
    placeholderCtrlEnter: "输入消息... (Ctrl+Enter 发送, Enter 换行, 粘贴图片)",
    placeholderEnter: "输入消息... (Enter 发送, Ctrl+Enter 换行, 粘贴图片)",
    sendAnswer: "发送回答",
    queueSend: "加入发送队列",
    send: "发送",
    stop: "停止",
    remove: "移除",
    removeReferenceSession: "移除引用会话",
    removeFileSnippet: "移除文件片段",
    removeImage: "移除图片",
    closeAttachmentNotice: "关闭附件提示",
    addAttachment: "添加附件",
    file: "文件",
    folder: "文件夹",
    session: "会话",
  },
  process: {
    thinking: "思考中",
    waitingEvent: "等待事件",
    interrupted: "已中断",
    thinkingPrefix: "正在思考",
    operationUnit: "个操作",
    fileUnit: "个文件",
    eventUnit: "条事件",
    stepUnit: "步",
    completed: "已完成",
    progressTitle: "步骤进度",
    elapsed: "处理耗时",
    emptyEvents: "等待 agent 事件...",
    errorLabel: "错误",
    commandGroupUnit: "条命令",
    inferredSteps: {
      analyze: "分析请求",
      operate: "执行操作",
      modify: "修改文件",
      verify: "验证总结",
    },
    status: {
      running: "进行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      pending: "待处理",
    },
    commandState: {
      running: "运行中",
      error: "失败",
      interrupted: "已中断",
      completed: "完成",
    },
    question: {
      failed: "用户选择处理失败",
      waiting: "等待用户选择",
      submitted: "已提交选择",
    },
    confirmNegativeTokens: ["no", "n", "false", "否", "取消"],
  },
} as const;

export const getChatComposerPlaceholder = (
  interactionDisabled: boolean,
  activeQuestionnaire: boolean,
  sendKey: string
) => {
  if (interactionDisabled) return uiText.chatComposer.creatingForkWithEllipsis;
  if (activeQuestionnaire) return uiText.chatComposer.submitQuestionnaire;
  return sendKey === "Ctrl+Enter"
    ? uiText.chatComposer.placeholderCtrlEnter
    : uiText.chatComposer.placeholderEnter;
};

export const getChatComposerSendTitle = (
  interactionDisabled: boolean,
  activeQuestionnaire: boolean,
  isAwaitingUIResponse: boolean,
  currentSessionRunning: boolean
) => {
  if (interactionDisabled) return uiText.chatComposer.creatingFork;
  if (activeQuestionnaire) return uiText.chatComposer.submitQuestionnaire;
  if (isAwaitingUIResponse) return uiText.chatComposer.sendAnswer;
  return currentSessionRunning ? uiText.chatComposer.queueSend : uiText.chatComposer.send;
};

export const getAttachmentKindLabel = (kind: AttachmentKind) =>
  kind === "folder" ? uiText.chatComposer.folder : uiText.chatComposer.file;

export const getRemovePathAttachmentLabel = (kind: AttachmentKind) =>
  `${uiText.chatComposer.remove}${getAttachmentKindLabel(kind)}`;

export const formatThinkingSummary = (preview: string) =>
  `${uiText.process.thinkingPrefix}: ${preview}`;

export const formatProcessCountSummary = (
  toolCount: number,
  diffCount: number,
  eventCount: number
) => {
  if (toolCount > 0 && diffCount > 0) {
    return `已执行 ${toolCount} ${uiText.process.operationUnit}, 修改 ${diffCount} ${uiText.process.fileUnit}`;
  }
  if (toolCount > 0) return `已执行 ${toolCount} ${uiText.process.operationUnit}`;
  if (diffCount > 0) return `已修改 ${diffCount} ${uiText.process.fileUnit}`;
  return `${eventCount} ${uiText.process.eventUnit}`;
};

export const formatStepProgress = (current: number, total: number) =>
  `第 ${current} / ${total} ${uiText.process.stepUnit}`;

export const formatCompletedStepProgress = (completed: number, total: number) =>
  `${uiText.process.completed} ${completed} / ${total}`;

export const getProcessStepStatusLabel = (status: ProcessStepStatus) =>
  uiText.process.status[status];

export const getProcessFileEntryTitle = (
  action: ProcessFileAction,
  count: number,
  running = false
) => {
  if (running) {
    switch (action) {
      case "read": return `正在读取 ${count} ${uiText.process.fileUnit}`;
      case "listed": return `正在查看 ${count} 个目录`;
      case "written": return `正在写入 ${count} ${uiText.process.fileUnit}`;
      case "edited": return `正在编辑 ${count} ${uiText.process.fileUnit}`;
      default: return `正在修改 ${count} ${uiText.process.fileUnit}`;
    }
  }

  switch (action) {
    case "read": return `已读取 ${count} ${uiText.process.fileUnit}`;
    case "listed": return `已查看 ${count} 个目录`;
    case "written": return `已写入 ${count} ${uiText.process.fileUnit}`;
    case "edited": return `已编辑 ${count} ${uiText.process.fileUnit}`;
    default: return `已修改 ${count} ${uiText.process.fileUnit}`;
  }
};

export const getProcessFileActionLabel = (action: ProcessFileAction) => {
  switch (action) {
    case "read": return "已读取";
    case "listed": return "已查看";
    case "written": return "已写入";
    case "edited": return "已编辑";
    default: return "已修改";
  }
};

export const getCommandStateLabel = (state: CommandState) => {
  if (state === "running") return uiText.process.commandState.running;
  if (state === "error") return uiText.process.commandState.error;
  if (state === "interrupted") return uiText.process.commandState.interrupted;
  return uiText.process.commandState.completed;
};

export const formatCommandGroupTitle = (count: number) =>
  `已运行 ${count} ${uiText.process.commandGroupUnit}`;

export const getQuestionTitle = (running = false, isError = false) => {
  if (isError) return uiText.process.question.failed;
  return running ? uiText.process.question.waiting : uiText.process.question.submitted;
};

export const isNegativeConfirmResponse = (value: string) =>
  (uiText.process.confirmNegativeTokens as readonly string[]).includes(value.trim().toLowerCase());

export const getToolErrorSummary = (toolKind: ToolSummaryKind, toolName: string) => {
  switch (toolKind) {
    case "read_file": return "读取文件失败";
    case "list_dir": return "读取目录失败";
    case "write_file": return "写入文件失败";
    case "edit_file": return "编辑文件失败";
    case "run_command": return "命令执行失败";
    case "search_files": return "文件搜索失败";
    case "search_text": return "内容搜索失败";
    case "web_fetch": return "网页获取失败";
    case "web_search": return "网络搜索失败";
    case "question": return getQuestionTitle(false, true);
    default: return `${toolName} 执行失败`;
  }
};

export const getToolActionSummary = (
  toolKind: ToolSummaryKind,
  toolName: string,
  running = false
) => {
  const prefix = running ? "正在运行" : "已运行";
  const completedPrefix = running ? "正在" : "已完成";

  switch (toolKind) {
    case "run_command":
      return toolName ? `${prefix} ${toolName}` : `${prefix}命令`;
    case "search_files":
      return `${completedPrefix}搜索文件`;
    case "search_text":
      return `${completedPrefix}搜索内容`;
    case "web_fetch":
      return `${completedPrefix}获取网页内容`;
    case "web_search":
      return `${completedPrefix}搜索网络`;
    case "question":
      return getQuestionTitle(running, false);
    default:
      return toolName ? `${prefix} ${toolName}` : `${prefix}工具`;
  }
};

export const getPlanStepFallbackTitle = (index: number) =>
  `步骤 ${index + 1}`;
