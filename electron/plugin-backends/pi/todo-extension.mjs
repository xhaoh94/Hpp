/**
 * Hpp 的任务列表扩展。
 *
 * 设计上对齐 Claude Code 的 TodoWrite / Codex 的 update_plan：每次调用提交
 * **完整任务列表**（整表覆盖），而不是 add/toggle 这类增量操作。原因是模型一次
 * 写清全貌更不容易漂移，界面也只需要吃快照。
 *
 * 状态存放在工具结果的 details.tasks 里（与 Pi 官方 todo 示例一致），所以会话
 * 分支 / fork 后能按分支历史重建，不依赖外部文件。
 */

export const TODO_TOOL_NAME = "todo_write";
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const MAX_TODO_ITEMS = 50;
const STATUS_ICONS = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
  cancelled: "✕",
};

export const TODO_GUIDANCE = [
  "多步任务用 todo_write 维护任务列表：任务达到 3 步及以上，或用户一次给出多项需求时，",
  "先列出完整任务列表再开始执行。",
  "开工前把当前任务标为 in_progress，做完立刻标为 completed；同一时刻只保留一个 in_progress。",
  "单步小任务不要调用 todo_write。",
].join("");

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => typeof value === "string" ? value.trim() : "";

/**
 * 校验并归一化模型提交的整张任务表。
 *
 * 校验失败返回 `{ error }`，由工具以 isError 返回、让模型自己纠正；这里不做
 * 静默修正（例如偷偷把多个 in_progress 改成 pending），否则界面和模型认知会漂移。
 */
export const normalizeTodoDraft = (value) => {
  if (!Array.isArray(value)) {
    return { error: "todos 必须是任务数组" };
  }
  if (value.length > MAX_TODO_ITEMS) {
    return { error: `任务最多 ${MAX_TODO_ITEMS} 项，当前 ${value.length} 项` };
  }
  const tasks = [];
  const seen = new Set();
  let inProgressCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const position = index + 1;
    if (!isRecord(item)) return { error: `第 ${position} 项不是对象` };
    const id = asString(item.id);
    if (!id) return { error: `第 ${position} 项缺少 id` };
    // 界面的计划步骤解析只认 #<字母数字开头>；id 里带空格/中文会让条目
    // 在悬浮条里静默消失，所以在写入前就拒绝。
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      return { error: `任务 id 只能包含字母、数字、下划线和连字符，且以字母或数字开头：${id}` };
    }
    if (seen.has(id)) return { error: `任务 id 重复：${id}` };
    const title = asString(item.title);
    if (!title) return { error: `任务 #${id} 缺少 title` };
    const status = item.status === undefined ? "pending" : asString(item.status);
    if (!TODO_STATUSES.includes(status)) {
      return { error: `任务 #${id} 的 status 无效：${status || "(空)"}；可用：${TODO_STATUSES.join(" / ")}` };
    }
    if (status === "in_progress") inProgressCount += 1;
    seen.add(id);
    const task = { id, title, status };
    // P4：任务可以被后台子 Agent 认领（owner），并声明依赖（blockedBy）。
    const owner = asString(item.owner);
    if (owner) task.owner = owner;
    if (Array.isArray(item.blockedBy)) {
      const blockedBy = [...new Set(item.blockedBy.map((value) => asString(value)).filter(Boolean))];
      if (blockedBy.length > 0) task.blockedBy = blockedBy;
    }
    const lastError = asString(item.lastError);
    if (lastError) task.lastError = lastError;
    tasks.push(task);
  }
  if (inProgressCount > 1) {
    return { error: `同一时刻只能有 1 个 in_progress，当前有 ${inProgressCount} 个` };
  }
  return { tasks };
};

const formatTodoLine = (task) => `#${task.id} ${STATUS_ICONS[task.status] || "○"} ${task.title}`;

export const formatTodoContent = (tasks) => {
  if (tasks.length === 0) return "任务列表已清空。";
  const completed = tasks.filter((task) => task.status === "completed").length;
  return [
    `任务列表已更新（${completed}/${tasks.length} 完成）：`,
    ...tasks.map(formatTodoLine),
  ].join("\n");
};

/**
 * 只保留未完成项用于注入上下文：已完成的不需要模型继续跟进，全部列出来只会
 * 每轮白烧 token。
 */
export const formatUnfinishedTodoContext = (tasks) => {
  const unfinished = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task.status === "pending" || task.status === "in_progress");
  if (unfinished.length === 0) return "";
  return [
    "当前任务列表（todo_write 状态）：",
    ...unfinished.map(formatTodoLine),
  ].join("\n");
};

/**
 * 从会话分支里找到最后一条 todo_write 结果携带的快照。
 *
 * 返回 null 表示分支里没有任何 todo_write（不要用空数组冒充，否则会把
 * 「还没建列表」误当成「列表已被清空」）。
 */
export const readTodoSnapshotFromBranch = (branch) => {
  let snapshot = null;
  for (const entry of Array.isArray(branch) ? branch : []) {
    if (!isRecord(entry)) continue;
    // P4 的后台状态变更通过 appendEntry 持久化；恢复时也要认这条路径。
    if (entry.customType === "hpp-todo") {
      const data = isRecord(entry.data) ? entry.data : isRecord(entry.details) ? entry.details : null;
      const normalized = normalizeTodoDraft(data?.tasks);
      if (normalized.tasks) snapshot = normalized.tasks;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : null;
    if (!message || message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;
    const details = isRecord(message.details) ? message.details : null;
    const normalized = normalizeTodoDraft(details?.tasks);
    if (normalized.tasks) snapshot = normalized.tasks;
  }
  return snapshot;
};

/**
 * 创建 todo 扩展实例。
 *
 * 返回的工厂函数额外挂着 getTasks / restoreFromSession / buildUnfinishedContext，
 * 供 worker 在压缩、系统提示注入和热切换时读取同一份内存状态。
 */
export const createHppTodoExtension = () => {
  let tasks = [];
  // 由扩展工厂在真实 pi 上补齐；后台状态变更需要 appendEntry 持久化。
  let persist = () => {};

  const getTasks = () => tasks.map((task) => ({ ...task }));

  const findTask = (id) => tasks.find((task) => task.id === String(id || ""));

  /**
   * 局部更新某个任务（P4：子 Agent 派发/结束时改 owner 和状态）。
   * 返回更新后的任务；找不到时返回 null。
   */
  const updateTask = (id, patch = {}) => {
    const targetId = String(id || "");
    const index = tasks.findIndex((task) => task.id === targetId);
    if (index < 0) return null;
    const next = { ...tasks[index] };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.owner !== undefined) {
      if (patch.owner) next.owner = String(patch.owner);
      else delete next.owner;
    }
    if (patch.lastError !== undefined) {
      if (patch.lastError) next.lastError = String(patch.lastError);
      else delete next.lastError;
    }
    tasks = tasks.map((task, taskIndex) => (taskIndex === index ? next : task));
    persist();
    return { ...next };
  };

  const restoreFromSession = (contextOrSessionManager) => {
    const manager = contextOrSessionManager?.sessionManager || contextOrSessionManager;
    if (typeof manager?.getBranch !== "function") return;
    const snapshot = readTodoSnapshotFromBranch(manager.getBranch());
    if (snapshot !== null) tasks = snapshot;
  };

  const extension = (pi) => {
    if (!pi || typeof pi.registerTool !== "function") return;
    persist = () => {
      if (typeof pi.appendEntry !== "function") return;
      try {
        pi.appendEntry("hpp-todo", { version: 1, tasks: getTasks() });
      } catch {
        // 持久化失败不阻断任务推进；工具结果里的 details 仍是权威快照。
      }
    };
    if (typeof pi.on === "function") {
      // 新会话 / 恢复 / fork 后按当前分支重建；session_tree 覆盖会话内切换分支。
      pi.on("session_start", (_event, context) => restoreFromSession(context));
      pi.on("session_tree", (_event, context) => restoreFromSession(context));
    }

    pi.registerTool({
      name: TODO_TOOL_NAME,
      label: "Todo",
      description: [
        "维护当前任务列表。每次提交完整列表（整表覆盖），不要只提交改动的项。",
        `status 取值：${TODO_STATUSES.join(" / ")}；同一时刻最多一个 in_progress。`,
        "任务达到 3 步及以上、或用户一次给出多项需求时使用；单步小任务不要用。",
      ].join(""),
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "完整任务列表（整表覆盖；提交空数组表示清空）",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "任务 id，需在列表内唯一（如 1、2、3）" },
                title: { type: "string", description: "一句话任务标题" },
                status: {
                  type: "string",
                  enum: TODO_STATUSES,
                  description: "pending / in_progress / completed / cancelled",
                },
                owner: { type: "string", description: "可选；认领该任务的子任务 id（P4 由 subagent 自动写入）" },
                blockedBy: {
                  type: "array",
                  items: { type: "string" },
                  description: "可选；依赖的任务 id。派发子 Agent 时只作提示，不会阻止执行",
                },
              },
              required: ["id", "title", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },

      async execute(_toolCallId, rawParams) {
        const params = isRecord(rawParams) ? rawParams : {};
        const normalized = normalizeTodoDraft(params.todos);
        if (normalized.error) {
          return {
            content: [{ type: "text", text: `todo_write 参数无效：${normalized.error}` }],
            details: { version: 1, error: normalized.error },
            isError: true,
          };
        }
        tasks = normalized.tasks;
        persist();
        return {
          content: [{ type: "text", text: formatTodoContent(tasks) }],
          details: { version: 1, tasks: getTasks() },
        };
      },
    });
  };

  extension.getTasks = getTasks;
  extension.findTask = findTask;
  extension.updateTask = updateTask;
  extension.restoreFromSession = restoreFromSession;
  extension.buildUnfinishedContext = () => formatUnfinishedTodoContext(tasks);
  return extension;
};