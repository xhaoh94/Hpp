import { describe, expect, it, vi } from "vitest";
import { buildStreamJsonUserMessage, CodebuddyAgent } from "./backend";

type MutableCodebuddyAgent = {
  turnActive: boolean;
  turnRevision: number;
  turnKind: "chat" | "compact";
  modelId: string;
  providerId: string | null;
  models: Array<{ id: string; contextWindow?: number }>;
  compactId: string | null;
  compactBoundarySeen: boolean;
  compactError: string | null;
  compactResolve: (() => void) | null;
  handleLine: (line: string, revision: number) => void;
  handleClose: (revision: number, code: number | null) => void;
  loadProviderConfig: (initializing?: boolean) => Promise<void>;
  resolveSelectedSkill: (action?: { kind?: string; name?: string }) => unknown;
  proc: { stdin: { write: (text: string) => void; writableEnded: boolean; destroyed: boolean; end: () => void }; exitCode: number | null } | null;
  pendingGuidance: number;
};

const mutable = (agent: CodebuddyAgent) => agent as unknown as MutableCodebuddyAgent;

const startChatTurn = (agent: CodebuddyAgent) => {
  Object.assign(mutable(agent), {
    turnActive: true,
    turnRevision: 1,
    turnKind: "chat",
    modelId: "glm-5.3",
    models: [{ id: "glm-5.3", contextWindow: 1_000_000 }],
  });
};

const line = (payload: Record<string, unknown>) => JSON.stringify(payload);

describe("CodebuddyAgent token usage", () => {
  it("assistant 与 result 不重复累加同一份用量", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    startChatTurn(agent);

    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 };
    mutable(agent).handleLine(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }], usage },
    }), 1);
    mutable(agent).handleLine(line({ type: "result", is_error: false, usage }), 1);

    const usages = events.filter((event) => event.type === "token_usage");
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheInputTokens: 30,
      // 上下文 = input + cache_read（+ cache_creation），窗口取模型真实值。
      contextTokens: 130,
      contextWindow: 1_000_000,
      contextPrecision: "estimated",
    });
  });

  it("没有 assistant 用量时用 result 兜底一次", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    startChatTurn(agent);

    mutable(agent).handleLine(line({
      type: "result",
      is_error: false,
      usage: { input_tokens: 12, output_tokens: 3 },
    }), 1);

    expect(events.filter((event) => event.type === "token_usage")).toHaveLength(1);
  });

  it("usage_update 上报精确上下文与分类明细", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    startChatTurn(agent);

    mutable(agent).handleLine(line({
      type: "system",
      subtype: "usage_update",
      _meta: {
        "codebuddy.ai/contextUsed": 26_186,
        "codebuddy.ai/usageByCategory": {
          systemPrompt: 1_588,
          conversation: 1_019,
          tools: 23_561,
          mcp: 0,
          skills: 18,
          version: 1,
        },
      },
    }), 1);

    const usage = events.find((event) => event.type === "token_usage");
    expect(usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 26_186,
      contextWindow: 1_000_000,
      contextPrecision: "exact",
    });
    expect(usage?.contextBreakdown).toEqual([
      { id: "codebuddy-context-systemPrompt", label: "System prompt", tokens: 1_588 },
      { id: "codebuddy-context-conversation", label: "对话", tokens: 1_019 },
      { id: "codebuddy-context-tools", label: "工具定义", tokens: 23_561 },
      { id: "codebuddy-context-skills", label: "技能", tokens: 18 },
    ]);
  });
});

describe("buildStreamJsonUserMessage", () => {
  it("把图片编码成 stream-json 的 image block", () => {
    const payload = JSON.parse(buildStreamJsonUserMessage("看图", [
      { data: "YWJj", mimeType: "image/png" },
    ]));
    expect(payload).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
        ],
      },
    });
  });

  it("没有文字时只发图片", () => {
    const payload = JSON.parse(buildStreamJsonUserMessage("", [
      { data: "YWJj", mimeType: "image/jpeg" },
    ]));
    expect(payload.message.content).toHaveLength(1);
    expect(payload.message.content[0].type).toBe("image");
  });
});

describe("CodebuddyAgent thinking", () => {  it("流式已发过思考时，助手消息不再重复整段内容并正确收尾", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    startChatTurn(agent);

    mutable(agent).handleLine(line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "先想一下" } },
    }), 1);
    mutable(agent).handleLine(line({
      type: "stream_event",
      event: { type: "content_block_stop" },
    }), 1);
    mutable(agent).handleLine(line({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "先想一下" },
          { type: "text", text: "结果是 2" },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }), 1);

    expect(events.filter((event) => event.type === "thinking_delta")).toHaveLength(1);
    expect(events.filter((event) => event.type === "thinking_end")).toHaveLength(1);
  });

  it("没有流式增量时用助手消息里的思考补发并收尾", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    startChatTurn(agent);

    mutable(agent).handleLine(line({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "完整思考" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }), 1);

    expect(events.map((event) => event.type)).toEqual(["thinking_delta", "thinking_end"]);
  });
});

describe("CodebuddyAgent compaction", () => {
  it("手动压缩的 boundary 归到 started 同一个 id", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      turnActive: true,
      turnRevision: 1,
      turnKind: "compact",
      compactId: "compact-one",
    });

    mutable(agent).handleLine(line({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-uuid",
      compact_metadata: { trigger: "manual" },
    }), 1);

    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      id: "compact-one",
      phase: "completed",
    }));
    expect(mutable(agent).compactBoundarySeen).toBe(true);
  });

  it("普通回合里的自动压缩按 boundary uuid 单独成条", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    startChatTurn(agent);

    mutable(agent).handleLine(line({
      type: "system",
      subtype: "compact_boundary",
      uuid: "auto-boundary",
      compact_metadata: { trigger: "auto" },
    }), 1);

    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      id: "auto-boundary",
      phase: "completed",
    }));
  });

  it("result 成功但没有 boundary 时，进程退出后判失败并唤醒等待方", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    const resolve = vi.fn();
    Object.assign(mutable(agent), {
      turnActive: true,
      turnRevision: 1,
      turnKind: "compact",
      compactId: "compact-two",
      compactResolve: resolve,
    });

    mutable(agent).handleLine(line({ type: "result", is_error: false }), 1);
    // 结果可能先于 boundary 到达，此时不能立刻判失败。
    expect(resolve).not.toHaveBeenCalled();
    expect(mutable(agent).compactError).toBeNull();

    mutable(agent).handleClose(1, 0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      id: "compact-two",
      phase: "failed",
    }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(mutable(agent).turnActive).toBe(false);
    expect(mutable(agent).compactError).toMatch(/进程退出/);
  });

  it("boundary 已到但进程直接退出时按成功收尾", () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    const resolve = vi.fn();
    Object.assign(mutable(agent), {
      turnActive: true,
      turnRevision: 1,
      turnKind: "compact",
      compactId: "compact-three",
      compactBoundarySeen: true,
      compactResolve: resolve,
    });

    mutable(agent).handleClose(1, 0);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(mutable(agent).compactError).toBeNull();
    expect(events.some((event) => event.type === "context_compaction" && event.phase === "failed")).toBe(false);
  });

  it("忙碌时拒绝再次压缩", async () => {
    const agent = new CodebuddyAgent("session-one");
    Object.assign(mutable(agent), { turnActive: true });
    await expect(agent.compact()).rejects.toThrow("SESSION_BUSY");
  });

  it("用户取消压缩时发 interrupted 而不是 failed", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
    Object.assign(mutable(agent), {
      turnActive: true,
      turnRevision: 1,
      turnKind: "compact",
      compactId: "compact-cancel",
    });
    await agent.abort();
    expect(events).toContainEqual(expect.objectContaining({
      type: "context_compaction",
      id: "compact-cancel",
      phase: "interrupted",
    }));
  });

  it("压缩卡住时会超时收尾，不会让会话永久 SESSION_BUSY", async () => {
    vi.useFakeTimers();
    try {
      const events: Record<string, unknown>[] = [];
      const agent = new CodebuddyAgent("session-one", (event) => events.push(event));
      Object.assign(mutable(agent), {
        _sessionFilePath: "session-1",
        turnActive: false,
        turnRevision: 0,
        turnKind: "chat",
      });
      vi.spyOn(agent as unknown as { resolveCli: () => unknown }, "resolveCli")
        .mockReturnValue({ scriptPath: "fake-codebuddy", bundled: false });
      vi.spyOn(agent as unknown as { loadProviderConfig: () => Promise<void> }, "loadProviderConfig")
        .mockResolvedValue(undefined);
      vi.spyOn(agent as unknown as { spawnTurn: () => unknown }, "spawnTurn")
        .mockReturnValue({ ok: true });

      const promise = agent.compact();
      const failure = expect(promise).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(180_000);
      await failure;

      expect(events).toContainEqual(expect.objectContaining({
        type: "context_compaction",
        phase: "failed",
        detail: expect.stringContaining("超时"),
      }));
      expect(mutable(agent).turnActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodebuddyAgent provider switch", () => {
  it("同一模型 ID 换渠道也要发 model_changed", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event), {
      getConfigState: async () => ({
        activeProviderId: "codebuddy-b",
        providers: [
          { providerId: "codebuddy-a", models: [{ id: "hy4flash-free" }] },
          { providerId: "codebuddy-b", models: [{ id: "hy4flash-free" }] },
        ],
      }),
    });
    Object.assign(mutable(agent), {
      providerId: "codebuddy-a",
      modelId: "hy4flash-free",
      models: [{ id: "hy4flash-free" }],
    });

    await mutable(agent).loadProviderConfig();

    expect(mutable(agent).providerId).toBe("codebuddy-b");
    expect(events).toContainEqual(expect.objectContaining({
      type: "model_changed",
      model: { id: "hy4flash-free", provider: "codebuddy-b" },
    }));
  });

  it("空模型渠道不再回退内置列表，也不发 model_changed", async () => {
    const events: Record<string, unknown>[] = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event), {
      getConfigState: async () => ({
        activeProviderId: "codebuddy-empty",
        providers: [{ providerId: "codebuddy-empty", models: [] }],
      }),
    });
    Object.assign(mutable(agent), {
      providerId: "codebuddy-empty",
      modelId: "old-model",
      models: [{ id: "old-model" }],
    });

    await mutable(agent).loadProviderConfig();

    // 渠道没有模型时保持空列表：不能让内置硬编码模型伪装成可用。
    expect(mutable(agent).models).toEqual([]);
    expect(mutable(agent).modelId).toBe("old-model");
    expect(events).not.toContainEqual(expect.objectContaining({ type: "model_changed" }));
  });

  it("没有模型时 getModels 返回空列表", async () => {
    const agent = new CodebuddyAgent("session-one");
    await expect(agent.getModels()).resolves.toEqual([]);
  });
});

describe("CodebuddyAgent skills", () => {
  it("listActions 返回数组（无技能时为空）", async () => {
    const agent = new CodebuddyAgent("session-one");
    await expect(agent.listActions()).resolves.toEqual(expect.any(Array));
  });

  it("选中不存在的技能时报 ACTION_NOT_FOUND", () => {
    const agent = new CodebuddyAgent("session-one");
    expect(() => mutable(agent).resolveSelectedSkill({ kind: "skill", name: "definitely-not-a-skill-xyz" }))
      .toThrow("ACTION_NOT_FOUND");
  });

  it("非技能动作不注入，交给普通消息处理", () => {
    const agent = new CodebuddyAgent("session-one");
    expect(mutable(agent).resolveSelectedSkill(undefined)).toBeNull();
    expect(mutable(agent).resolveSelectedSkill({ kind: "command", name: "loop" })).toBeNull();
  });
});

describe("CodebuddyAgent guidance", () => {
  it("空闲时拒绝引导", async () => {
    const agent = new CodebuddyAgent("session-one");
    await expect(agent.sendGuidance("插一句")).rejects.toThrow("SESSION_NOT_RUNNING");
  });

  it("运行中把引导写入 stdin，但不结束回合", async () => {
    const events: Array<Record<string, unknown>> = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event as Record<string, unknown>));
    const writes: string[] = [];
    const fakeProc = {
      stdin: {
        write: (text: string) => { writes.push(text); },
        writableEnded: false,
        destroyed: false,
        end: () => undefined,
      },
      exitCode: null,
    };
    Object.assign(mutable(agent), {
      turnActive: true,
      turnRevision: 1,
      turnKind: "chat",
      proc: fakeProc,
    });

    const result = await agent.sendGuidance("改为只回复 999");

    expect(result.guidanceId).toMatch(/^codebuddy-guidance-/);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("999");
    expect(mutable(agent).pendingGuidance).toBe(1);
    expect(mutable(agent).turnActive).toBe(true);
    // 必须发确认事件，否则渲染层的队列项一直显示“等待插入”。
    expect(events).toContainEqual(expect.objectContaining({ type: "guidance_response_started" }));
  });

  it("取消引导时明确告知无法撤回", async () => {
    const agent = new CodebuddyAgent("session-one");
    await expect(agent.cancelGuidance("g1")).resolves.toEqual({
      cancelled: false,
      reason: expect.stringContaining("无法撤回"),
    });
  });
});

describe("CodebuddyAgent fork", () => {
  it("生成 fork 描述符，包含源会话和新会话 ID", async () => {
    const agent = new CodebuddyAgent("session-one");
    const result = await agent.forkSession({
      newSessionId: "new-session-id",
      sourceSessionFilePath: "source-session-id",
      sourceUserMessageIndex: 0,
      targetTurnId: "turn-1",
    });
    expect(result.supported).toBe(true);
    expect(result.success).toBe(true);
    expect(result.sessionFilePath).toMatch(/^hpp-codebuddy-fork:v1:/);
    const encoded = result.sessionFilePath!.slice("hpp-codebuddy-fork:v1:".length);
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toContain("new-session-id");
  });

  it("缺少会话 ID 时 fork 失败", async () => {
    const agent = new CodebuddyAgent("session-one");
    const result = await agent.forkSession({ newSessionId: "", sourceUserMessageIndex: 0 });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("缺少");
  });

  it("会话 ID 含非法字符时拒绝 fork", async () => {
    const agent = new CodebuddyAgent("session-one");
    const result = await agent.forkSession({
      newSessionId: "bad id with space",
      sourceSessionFilePath: "source",
      sourceUserMessageIndex: 0,
    });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("非法字符");
  });
});

describe("CodebuddyAgent plan", () => {
  it("TaskCreate 转成 plan_update 步骤，不发普通工具卡片", () => {
    const events: Array<Record<string, unknown>> = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event as Record<string, unknown>));
    const line = (payload: Record<string, unknown>) => JSON.stringify(payload);

    mutable(agent).turnKind = "chat";
    mutable(agent).handleLine(line({
      type: "assistant",
      message: { content: [{
        type: "tool_use", id: "task-1", name: "TaskCreate",
        input: { subject: "添加记住我复选框" },
      }] },
    }), 0);

    expect(events).toContainEqual(expect.objectContaining({ type: "plan_update" }));
    const plan = events.find((e) => e.type === "plan_update") as { steps: Array<{ title: string; status: string }> };
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].title).toBe("添加记住我复选框");
    expect(plan.steps[0].status).toBe("pending");
    expect(events.some((e) => e.type === "tool_start")).toBe(false);
  });

  it("TaskUpdate 更新对应步骤状态", () => {
    const events: Array<Record<string, unknown>> = [];
    const agent = new CodebuddyAgent("session-one", (event) => events.push(event as Record<string, unknown>));
    const line = (payload: Record<string, unknown>) => JSON.stringify(payload);

    mutable(agent).turnKind = "chat";
    mutable(agent).handleLine(line({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "步骤一" } },
      { type: "tool_use", id: "t2", name: "TaskCreate", input: { subject: "步骤二" } },
    ] } }), 0);
    mutable(agent).handleLine(line({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t3", name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } },
    ] } }), 0);

    const plans = events.filter((e) => e.type === "plan_update") as Array<{ steps: Array<{ title: string; status: string }> }>;
    const last = plans[plans.length - 1];
    expect(last.steps.map((s) => [s.title, s.status])).toEqual([
      ["步骤一", "pending"],
      ["步骤二", "running"],
    ]);
  });
});
