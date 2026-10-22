import { describe, expect, it } from "vitest";
import {
  getOpenCodeProtocol,
  parseOpenCodeMajorVersion,
  resolveOpenCodeProtocolId,
} from "./protocol";

describe("OpenCode protocol selection", () => {
  it("parses the CLI major version from common --version outputs", () => {
    expect(parseOpenCodeMajorVersion("2.0.30")).toBe(2);
    expect(parseOpenCodeMajorVersion("v1.18.18")).toBe(1);
    expect(parseOpenCodeMajorVersion("1.18.18-beta.2")).toBe(1);
    // 带前缀的输出也要能识别（包装脚本/CLI 输出格式不一致）。
    expect(parseOpenCodeMajorVersion("opencode 2.1.0")).toBe(2);
    expect(parseOpenCodeMajorVersion(undefined)).toBeNull();
  });

  it("selects V2 for opencode 2.x and V1 otherwise", () => {
    expect(resolveOpenCodeProtocolId("2.0.30")).toBe("v2");
    expect(resolveOpenCodeProtocolId("v2.1.0-beta.1")).toBe("v2");
    expect(resolveOpenCodeProtocolId("1.18.18")).toBe("v1");
    // 探测失败时保持现有行为（V1）。
    expect(resolveOpenCodeProtocolId(undefined)).toBe("v1");
    expect(resolveOpenCodeProtocolId("not-a-version")).toBe("v1");
  });

  it("honours the explicit override used for troubleshooting", () => {
    expect(resolveOpenCodeProtocolId("2.0.30", "v1")).toBe("v1");
    expect(resolveOpenCodeProtocolId("1.18.18", "v2")).toBe("v2");
    expect(resolveOpenCodeProtocolId("1.18.18", "auto")).toBe("v1");
  });
});

describe("OpenCode V2 protocol adapter", () => {
  const v2 = getOpenCodeProtocol("v2");

  it("marks V2 as having an explicit execution lifecycle", () => {
    // 2.x 用 session.execution.* 收尾，不能再靠「空闲 800ms」判定 turn 结束。
    expect(v2.executionLifecycle).toBe(true);
    expect(getOpenCodeProtocol("v1").executionLifecycle).toBe(false);
  });

  it("prefers /api routes and keeps V1 paths as a fallback", () => {
    expect(v2.eventPaths()).toEqual(["/api/event", "/event"]);
    expect(v2.createSessionPaths()).toEqual(["/api/session", "/session"]);
    expect(v2.promptPaths("ses_1")).toEqual(["/api/session/ses_1/prompt", "/session/ses_1/prompt_async"]);
    // 2.x 把回复挂在 session 下，V1 路径仍作为回退候选。
    expect(v2.permissionReplyPaths("ses_1", "per_1")).toEqual([
      "/api/session/ses_1/permission/per_1/reply",
      "/permission/per_1/reply",
    ]);
    expect(v2.permissionReplyBody("once")).toEqual({ decision: "once" });
    // 2.x 的问卷走 session form（question.asked 在 2.0 里已经不存在）。
    expect(v2.questionReplyPaths("ses_1", "que_1")).toEqual([
      "/api/session/ses_1/form/que_1/reply",
      "/question/que_1/reply",
    ]);
    expect(v2.questionRejectRequest("ses_1", "que_1")).toEqual({
      method: "DELETE",
      paths: ["/api/session/ses_1/form/que_1", "/question/que_1/reject"],
    });
    expect(v2.abortPaths("ses_1")).toEqual(["/api/session/ses_1/interrupt", "/session/ses_1/abort"]);
    expect(v2.diffPaths("ses_1", "msg_1")).toEqual([
      "/api/session/ses_1/diff?from=msg_1",
      "/session/ses_1/diff?messageID=msg_1",
    ]);
    expect(v2.forkBody("msg_1")).toEqual({ before: "msg_1" });
    expect(v2.commandBody({
      command: "commit",
      arguments: "fix bug",
      parts: [
        { type: "text", text: "ignored" },
        { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
      ],
    })).toEqual({
      name: "commit",
      text: "fix bug",
      files: [{ uri: "data:image/png;base64,AAA", name: "a.png" }],
      delivery: "steer",
    });
  });

  it("unwraps the V2 event envelope into the V1 properties shape", () => {
    const normalized = v2.normalizeEvent({
      id: "evt_1",
      type: "message.part.delta",
      time: 1,
      context: { directory: "/repo" },
      payload: { sessionID: "ses_1", partID: "prt_1", delta: "hi" },
    });
    expect(normalized).toEqual({
      type: "message.part.delta",
      properties: { sessionID: "ses_1", partID: "prt_1", delta: "hi" },
    });
  });

  it("tolerates the transitional properties/data envelopes", () => {
    expect(v2.normalizeEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }))
      .toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } });
    expect(v2.normalizeEvent({ type: "session.idle", data: { sessionID: "ses_2" } }))
      .toEqual({ type: "session.idle", properties: { sessionID: "ses_2" } });
    expect(v2.normalizeEvent({ payload: {} })).toBeNull();
  });

  it("rewrites the prompt payload from parts to text + files", () => {
    const body = v2.promptBody({
      parts: [
        { type: "text", text: "hello" },
        { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
      ],
      system: "rules",
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      variant: "high",
    });
    expect(body).toEqual({
      text: "hello",
      files: [{ uri: "data:image/png;base64,AAA", name: "a.png" }],
      delivery: "steer",
    });
  });

  it("translates 2.x session.* events into the shapes the backend already handles", () => {
    expect(v2.normalizeEvent({
      id: "evt",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 2, delta: "hi" },
    })).toEqual({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        partID: "msg_1:text:2",
        part: { type: "text" },
        delta: "hi",
      },
    });

    expect(v2.normalizeEvent({
      type: "session.reasoning.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 1, delta: "thinking" },
    })).toMatchObject({
      type: "message.part.delta",
      properties: { field: "thinking", delta: "thinking" },
    });

    expect(v2.normalizeEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } }))
      .toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } });

    expect(v2.normalizeEvent({ type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "boom" } } }))
      .toEqual({ type: "session.error", properties: { sessionID: "ses_1", error: { message: "boom" } } });

    // 2.x 的 inactivity/user 中断应显示为"已中断"，不能当作正常完成。
    expect(v2.normalizeEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "inactivity" } }))
      .toEqual({ type: "aborted", properties: { sessionID: "ses_1", detail: "inactivity" } });

    // 2.x 的每次模型调用在一次 step.ended 里给出完整用量；input 不含缓存，
    // contextTokens 需要把缓存读/写一并算进去（与 1.x 的 part.tokens 同口径）。
    expect(v2.normalizeEvent({
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      },
    })).toEqual({
      type: "token_usage",
      properties: {
        sessionID: "ses_1",
        inputTokens: 140,
        outputTokens: 20,
        cacheInputTokens: 30,
        contextTokens: 140,
        contextPrecision: "official",
      },
    });

    // 没有 tokens 的失败 step 保持透传，不产生 0 用量事件。
    expect(v2.normalizeEvent({ type: "session.step.failed", data: { sessionID: "ses_1", assistantMessageID: "msg_1" } }))
      .toEqual({ type: "session.step.failed", properties: { sessionID: "ses_1", assistantMessageID: "msg_1" } });

    expect(v2.normalizeEvent({
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", id: "call_1", name: "bash", assistantMessageID: "msg_1" },
    })).toEqual({ type: "session.tool.input.started", properties: { sessionID: "ses_1", id: "call_1", name: "bash", assistantMessageID: "msg_1" } });

    expect(v2.normalizeEvent({
      type: "session.tool.called",
      data: { sessionID: "ses_1", id: "call_1", input: { command: "ls" }, assistantMessageID: "msg_1" },
    })).toMatchObject({
      type: "message.part.updated",
      properties: { part: { type: "tool", tool: "bash", callID: "call_1" } },
    });

    expect(v2.normalizeEvent({
      type: "session.tool.success",
      data: { sessionID: "ses_1", id: "call_1", content: [{ type: "text", text: "done" }], assistantMessageID: "msg_1" },
    })).toMatchObject({
      type: "message.part.updated",
      properties: { part: { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", output: "done" } } },
    });

    expect(v2.normalizeEvent({ type: "session.compaction.ended", data: { sessionID: "ses_1" } }))
      .toEqual({ type: "session.compacted", properties: { sessionID: "ses_1" } });

    // 未知事件保持透传，交给现有「不认识就忽略」的逻辑。
    expect(v2.normalizeEvent({ type: "session.inbox.enqueued", data: { sessionID: "ses_1" } }))
      .toEqual({ type: "session.inbox.enqueued", properties: { sessionID: "ses_1" } });
  });

  it("maps 2.x session forms onto the questionnaire contract", () => {
    const created = v2.normalizeEvent({
      id: "evt_form",
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "需要你的选择",
          fields: [
            { key: "plan", type: "select", title: "选哪个方案", options: [{ label: "A" }, { label: "B" }] },
            { key: "notes", type: "multiselect", title: "补充", options: [{ label: "x" }, { label: "y" }] },
          ],
        },
      },
    });
    expect(created).toEqual({
      type: "question.asked",
      properties: {
        id: "frm_1",
        sessionID: "ses_1",
        title: "需要你的选择",
        questions: [
          { id: "plan", question: "选哪个方案", header: "选哪个方案", multiSelect: false, options: [{ label: "A", value: "A" }, { label: "B", value: "B" }] },
          { id: "notes", question: "补充", header: "补充", multiSelect: true, options: [{ label: "x", value: "x" }, { label: "y", value: "y" }] },
        ],
      },
    });

    // 回复体按 form 字段 key 组装（2.x 要 { answer: { key: value } }）。
    expect(v2.questionReplyBody("ses_1", "frm_1", [["A"], ["x", "y"]])).toEqual({
      answer: { plan: "A", notes: ["x", "y"] },
    });

    expect(v2.normalizeEvent({ type: "form.replied", data: { id: "frm_1", sessionID: "ses_1" } }))
      .toEqual({ type: "question.replied", properties: { id: "frm_1", sessionID: "ses_1" } });
  });

  it("normalizes the flat V2 message list back to the V1 { info, parts } shape", () => {
    // 请求带 order=desc，所以列表是最新在前；归一化后要恢复成升序。
    const normalized = v2.normalizeMessages([
      {
        id: "msg_comp",
        sessionID: "ses_1",
        time: { created: 3 },
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "s",
        recent: "r",
      },
      {
        id: "msg_a",
        sessionID: "ses_1",
        time: { created: 2 },
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [
          { type: "text", text: "answer" },
          { type: "reasoning", text: "why" },
          { type: "tool", id: "call_1", name: "bash", state: {} },
        ],
      },
      {
        id: "msg_u",
        sessionID: "ses_1",
        time: { created: 1 },
        type: "user",
        text: "hello",
        files: [
          // 2.x 的 user 消息附件是 { data, mime, source }，不是 PromptInput 的 uri。
          { data: "AAA", mime: "image/png", source: { type: "inline" }, name: "a.png" },
          { data: "", mime: "image/png", source: { type: "uri", uri: "file:///tmp/b.png" }, name: "b.png" },
        ],
      },
      { id: "msg_sys", sessionID: "ses_1", time: { created: 0 }, type: "system", text: "ignored" },
    ]);
    expect(normalized).toEqual([
      {
        info: { id: "msg_u", role: "user", time: { created: 1 } },
        parts: [
          { type: "text", text: "hello" },
          { type: "file", url: "data:image/png;base64,AAA", filename: "a.png" },
          { type: "file", url: "file:///tmp/b.png", filename: "b.png" },
        ],
      },
      {
        info: { id: "msg_a", role: "assistant", time: { created: 2 } },
        parts: [
          { type: "text", text: "answer" },
          { type: "thinking", text: "why" },
        ],
      },
      {
        info: { id: "msg_comp", role: "assistant", summary: true, time: { created: 3 } },
        parts: [],
      },
    ]);
  });

  it("keeps the V1 adapter byte-compatible with the current payloads", () => {
    const v1 = getOpenCodeProtocol("v1");
    const body = { parts: [{ type: "text", text: "hello" }], agent: "build" };
    expect(v1.promptBody(body)).toBe(body);
    expect(v1.eventPaths()).toBe("/event");
    expect(v1.permissionReplyBody("reject")).toEqual({ reply: "reject" });
    expect(v1.normalizeEvent({ type: "session.idle", properties: { sessionID: "s" } }))
      .toEqual({ type: "session.idle", properties: { sessionID: "s" } });
    const messages = [{ info: { id: "m", role: "assistant" }, parts: [] }];
    expect(v1.normalizeMessages(messages)).toBe(messages);
    expect(v1.modelPaths("ses_1")).toBeNull();
    expect(v1.agentPaths("ses_1")).toBeNull();
  });
});
