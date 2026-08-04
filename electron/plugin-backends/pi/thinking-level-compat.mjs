/**
 * Compatibility helpers for Pi models whose OpenAI Responses endpoint does
 * not accept Pi's lowest/off wire-level reasoning values.
 *
 * Pi's default model catalogue assumes that an unconfigured map accepts the
 * canonical levels `off`, `minimal`, `low`, `medium` and `high`. GPT-5.6
 * Responses gateways instead advertise `low`, `medium`, `high`, `xhigh` and
 * `max`, and reject both `minimal` and `none`. Keep Hpp's six user-facing
 * choices intact, but fix the wire payload at the last possible point.
 */

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

const isGpt56Model = (model) =>
  /\bgpt[-_]?5\.6(?:[-_].*)?\b/.test(String(model?.id || "").trim().toLowerCase());

/** Return true for the GPT-5.6 Responses family that needs Hpp's compatibility layer. */
export const usesImplicitOpenAIResponsesThinking = (model) =>
  isRecord(model) && model.api === "openai-responses" && isGpt56Model(model);

const GPT56_PI_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

/**
 * Fill Pi's model-level capability map for custom GPT-5.6 definitions.
 *
 * Custom models.json entries commonly omit this map, while the downloaded Pi
 * catalogue currently marks off/minimal as null. Hpp still exposes those two
 * compatibility choices and rewrites them at the provider boundary. Supplying
 * xhigh/max here also prevents Pi from clamping Hpp's xhigh choice to high.
 */
export const withImplicitOpenAIResponsesThinkingLevels = (model) => {
  if (!usesImplicitOpenAIResponsesThinking(model)) return model;
  const currentMap = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  let changed = false;
  const thinkingLevelMap = { ...currentMap };
  for (const [level, fallback] of Object.entries(GPT56_PI_THINKING_LEVEL_MAP)) {
    if (thinkingLevelMap[level] !== undefined && thinkingLevelMap[level] !== null) continue;
    thinkingLevelMap[level] = fallback;
    changed = true;
  }
  return changed ? { ...model, thinkingLevelMap } : model;
};

const withoutReasoning = (payload) => {
  const nextPayload = { ...payload };
  delete nextPayload.reasoning;
  if (Array.isArray(nextPayload.include)) {
    const include = nextPayload.include.filter((item) =>
      !String(item || "").trim().toLowerCase().startsWith("reasoning."));
    if (include.length > 0) nextPayload.include = include;
    else delete nextPayload.include;
  }
  return nextPayload;
};

const mappedEffort = (model, level) => {
  const value = model?.thinkingLevelMap?.[level];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
};

const withReasoningEffort = (payload, effort) => ({
  ...payload,
  reasoning: { ...(isRecord(payload.reasoning) ? payload.reasoning : {}), effort },
});

/**
 * Normalize an OpenAI Responses request payload for an implicit compatibility
 * model. The returned value is safe to pass to the Pi provider; unrelated
 * payloads are returned unchanged.
 */
export const normalizeImplicitOpenAIResponsesPayload = (payload, model, thinkingLevel) => {
  if (!usesImplicitOpenAIResponsesThinking(model) || !isRecord(payload)) return payload;
  const reasoning = payload.reasoning;
  const effort = isRecord(reasoning)
    ? String(reasoning.effort || "").trim().toLowerCase()
    : "";
  const selectedLevel = String(thinkingLevel || "").trim().toLowerCase();

  // Prefer the canonical session selection over the generated payload. This
  // also repairs Pi/extension combinations that retain a stale reasoning
  // object or encrypted-content include after the user selects Off. Older Pi
  // SDKs do not expose context.thinkingLevel, so retain the payload fallback.
  if (selectedLevel === "off" || selectedLevel === "none") {
    const mapped = mappedEffort(model, "off");
    return mapped && mapped !== "off" && mapped !== "none"
      ? withReasoningEffort(payload, mapped)
      : withoutReasoning(payload);
  }
  if (!selectedLevel && (effort === "none" || effort === "off")) {
    return withoutReasoning(payload);
  }

  if (selectedLevel === "minimal") {
    const mapped = mappedEffort(model, "minimal");
    return withReasoningEffort(payload, mapped && mapped !== "minimal" ? mapped : "low");
  }
  if (!selectedLevel && effort === "minimal") {
    return withReasoningEffort(payload, "low");
  }

  return payload;
};
