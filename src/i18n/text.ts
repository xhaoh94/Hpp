export type AttachmentKind = "file" | "folder" | string;
export type ProcessFileAction = "read" | "listed" | "written" | "edited" | "modified" | undefined;
export type ProcessStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type CommandState = "running" | "completed" | "warning" | "error" | "interrupted" | undefined;
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
    placeholderCtrlEnter: "Ctrl+Enter 发送, Enter 换行",
    placeholderEnter: "Enter 发送, Ctrl+Enter 换行",
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
    narration: "正文输出",
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
    modelRequestFailed: "模型请求失败",
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
      warning: "非零退出",
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
  review: {
    audit: "审核",
    splitView: "并排对比",
    unifiedView: "统一视图",
    viewMode: "视图模式",
    before: "修改前",
    after: "修改后",
    files: "文件",
    noChanges: "没有可审查的改动",
    noPatch: "此文件没有可对比的补丁",
    locate: "在文件管理器中定位",
    open: "打开文件",
    close: "关闭",
    collapseFiles: "收起文件列表",
    expandFiles: "展开文件列表",
    diffNav: "修改点导航",
    prevDiff: "上一个修改点",
    nextDiff: "下一个修改点",
    showDeleted: "在右侧显示被删除的行",
    hideDeleted: "隐藏右侧被删除的行",
    loading: "正在加载文件内容…",
    fileCount: (count: number) => `共 ${count} 个变更文件`,
    truncated: (limit: number) => `内容过长，仅显示前 ${limit} 行`,
  },
  editor: {
    modeName: "编辑器模式",
    previewModeName: "对话模式",
    toggleEditorMode: "切换编辑器模式",
    togglePreviewMode: "切换为对话模式",
    emptyTitle: "编辑器中还没有打开的文件",
    emptyDesc: "从左侧文件树、会话消息或全局搜索 (Ctrl+P) 中选择文件即可在编辑器中打开",
    pin: "固定标签",
    unpin: "取消固定",
    close: "关闭",
    closeOthers: "关闭其他",
    closeSaved: "关闭已保存",
    closeAll: "关闭全部",
    revealInSidebar: "定位到资源管理器视图",
    openInSystemExplorer: "在文件资源管理器打开",
    closeOthersConfirm: (count: number) => `有 ${count} 个文件未保存，仍然关闭？`,
    closeAllConfirm: (count: number) => `有 ${count} 个文件未保存，仍然关闭？`,
    unsavedTitle: "未保存的更改",
    unsavedMessage: "该文件有未保存的更改。",
    saveAndClose: "保存并关闭",
    discardChanges: "放弃更改",
    cancel: "取消",
    saving: "正在保存…",
    saved: (name: string) => `${name} 已保存`,
    saveFailed: "保存失败",
    readOnlyBinary: "该文件为二进制或无法编辑的格式，仅可查看。",
    readOnlyError: "无法读取文件",
    loading: "加载中...",
    closeTab: "关闭标签页",
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

export const formatModelRequestFailure = (detail?: string) => {
  const normalizedDetail = detail?.trim();
  return normalizedDetail
    ? `${uiText.process.modelRequestFailed}：${normalizedDetail}`
    : `${uiText.process.modelRequestFailed}，请检查模型配置或网络连接后重试。`;
};

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
  if (state === "warning") return uiText.process.commandState.warning;
  if (state === "error") return uiText.process.commandState.error;
  if (state === "interrupted") return uiText.process.commandState.interrupted;
  return uiText.process.commandState.completed;
};

export const getCommandNonZeroSummary = (exitCode?: number) =>
  typeof exitCode === "number"
    ? `命令返回非零退出码 ${exitCode}`
    : "命令返回非零状态";

export const formatCommandGroupTitle = (count: number) =>
  `已运行 ${count} ${uiText.process.commandGroupUnit}`;

export const getQuestionTitle = (running = false, isError = false) => {
  if (isError) return uiText.process.question.failed;
  return running ? uiText.process.question.waiting : uiText.process.question.submitted;
};

export const isNegativeConfirmResponse = (value: string) =>
  (uiText.process.confirmNegativeTokens as readonly string[]).includes(value.trim().toLowerCase());

export const getToolWarningSummary = (toolKind: ToolSummaryKind, toolName: string) => {
  switch (toolKind) {
    case "read_file": return "读取文件未成功";
    case "list_dir": return "读取目录未成功";
    case "write_file": return "写入文件未成功";
    case "edit_file": return "编辑文件未成功";
    case "run_command": return "命令执行未成功";
    case "search_files": return "文件搜索未成功";
    case "search_text": return "内容搜索未成功";
    case "web_fetch": return "网页获取未成功";
    case "web_search": return "网络搜索未成功";
    case "question": return getQuestionTitle(false, true);
    default: return `${toolName} 执行未成功`;
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
  `处理第 ${index + 1} 项任务：Agent 暂未提供具体执行说明`;
