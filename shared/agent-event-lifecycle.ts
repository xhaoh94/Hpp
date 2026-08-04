export type AgentLifecycleEvent = Record<string, unknown> & { type?: unknown };

const TURN_START_EVENT_TYPES = new Set([
  "turn_lifecycle",
  "message_start",
  "stream_start",
  "agent_start",
]);

const ACTIVE_LIFECYCLE_STATES = new Set([
  "active",
  "in_progress",
  "inprogress",
  "pending",
  "queued",
  "running",
  "started",
  "starting",
  "working",
]);

const TERMINAL_LIFECYCLE_STATES = new Set([
  "cancelled",
  "canceled",
  "complete",
  "completed",
  "done",
  "error",
  "failed",
  "failure",
  "idle",
  "interrupted",
  "skipped",
  "stopped",
  "success",
  "succeeded",
]);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const normalizeState = (...values: unknown[]) => {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
};

const normalizeKind = (value: unknown) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "");

const getEventKind = (event: AgentLifecycleEvent) => normalizeKind(
  event.entryType || event.kind || event.mode || event.toolKind || event.toolName || event.name,
);

const isQuestionKind = (kind: string) => [
  "question",
  "askuser",
  "askuserquestion",
  "requestuserinput",
  "useraskquestion",
].includes(kind);

const isPlanKind = (event: AgentLifecycleEvent) => [
  event.entryType,
  event.kind,
  event.mode,
  event.name,
  event.toolName,
  event.title,
].map(normalizeKind).some((kind) => (
  kind === "plan" ||
  kind === "todo" ||
  kind === "step" ||
  kind.includes("planupdate") ||
  kind.includes("todoupdate") ||
  kind.includes("stepupdate")
));

const isPendingQuestion = (event: AgentLifecycleEvent) => {
  const state = normalizeState(event.state, event.status, event.phase);
  return !state || (!TERMINAL_LIFECYCLE_STATES.has(state) && state !== "warning");
};

const getPlanStepState = (step: unknown) => {
  if (typeof step === "string") {
    const value = step.trim();
    const checkbox = value.match(/^\[([ xX-])\]/);
    if (checkbox) return checkbox[1].toLowerCase() === "x" ? "completed" : "pending";
    const prefixedState = normalizeState(value.match(/^([a-z]+(?:[_ -][a-z]+)*)\s+/i)?.[1]);
    return ACTIVE_LIFECYCLE_STATES.has(prefixedState) || TERMINAL_LIFECYCLE_STATES.has(prefixedState)
      ? prefixedState
      : "pending";
  }
  const record = asRecord(step);
  return normalizeState(record.status, record.state, record.phase) || "pending";
};

const getPlanContinuation = (event: AgentLifecycleEvent): boolean | null => {
  const detail = asRecord(event.detail);
  const args = asRecord(event.args);
  const input = asRecord(event.input);
  const candidates = [
    event.steps,
    event.plan,
    event.todos,
    event.items,
    detail.steps,
    detail.plan,
    detail.todos,
    detail.items,
    args.steps,
    args.plan,
    args.todos,
    args.items,
    input.steps,
    input.plan,
    input.todos,
    input.items,
  ];
  const steps = candidates.find((candidate) => Array.isArray(candidate) && candidate.length > 0);
  if (!Array.isArray(steps)) return null;
  return steps.some((step) => ACTIVE_LIFECYCLE_STATES.has(getPlanStepState(step)));
};

const isSubagentContinuation = (event: AgentLifecycleEvent) => {
  const directState = normalizeState(event.state, event.status);
  if (directState) return ACTIVE_LIFECYCLE_STATES.has(directState);

  const array = Array.isArray(event.subagents)
    ? event.subagents
    : Array.isArray(event.agents)
      ? event.agents
      : [];
  const stateMap = asRecord(event.agentsStates);
  const nestedStates = [
    ...array.map((item) => {
      const record = asRecord(item);
      return normalizeState(record.status, record.state);
    }),
    ...Object.values(stateMap).map((item) => {
      const record = asRecord(item);
      return normalizeState(record.status, record.state, item);
    }),
  ].filter(Boolean);
  if (nestedStates.some((state) => ACTIVE_LIFECYCLE_STATES.has(state))) return true;
  if (nestedStates.length > 0) return false;
  return normalizeState(event.phase) !== "completed";
};

/**
 * Whether an event is affirmative evidence that an Agent turn is still doing
 * work. Terminal/tail records may still update the UI, but must not cancel an
 * `agent_end` idle reconciliation or extend the visible running duration.
 */
export function isAgentTurnContinuationEvidence(event: AgentLifecycleEvent) {
  const type = typeof event.type === "string" ? event.type : "";
  if (TURN_START_EVENT_TYPES.has(type)) return true;
  if (type === "stream_delta" || type === "thinking_delta") return !!event.delta;
  if (type === "stream_snapshot") return !!String(event.content || "");
  if (type === "commentary_delta") {
    const itemId = String(event.itemId || event.id || "").trim();
    return !!itemId && typeof event.delta === "string" && !!event.delta;
  }
  if (type === "tool_start") return true;
  if (
    type === "commentary_end" ||
    type === "thinking_end" ||
    type === "tool_end" ||
    type === "diff_update"
  ) {
    return false;
  }
  if (type === "subagent_event") return isSubagentContinuation(event);
  if (type === "plan_update") {
    const planContinuation = getPlanContinuation(event);
    return planContinuation ?? ACTIVE_LIFECYCLE_STATES.has(
      normalizeState(event.state, event.status, event.phase),
    );
  }
  if (type === "process_event") {
    if (isPlanKind(event)) {
      const planContinuation = getPlanContinuation(event);
      if (planContinuation !== null) return planContinuation;
    }
    const kind = getEventKind(event);
    if (kind === "subagent") return isSubagentContinuation(event);
    if (isQuestionKind(kind)) return isPendingQuestion(event);
    return ACTIVE_LIFECYCLE_STATES.has(
      normalizeState(event.state, event.status, event.phase),
    );
  }
  if (
    type === "user_ask_question" ||
    type === "ask_user_question" ||
    type === "ask_user" ||
    isQuestionKind(getEventKind(event))
  ) {
    return isPendingQuestion(event);
  }
  return false;
}
