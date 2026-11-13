/**
 * 部分 OpenAI 兼容网关会把上游临时故障包装成 HTTP 400。例如 edgefn 的
 * GLM-5.3-Flash 会返回：
 *
 *   400: {"code":400,"reason":"InvalidRequestBody","message":"无效的请求参数.",
 *         "metadata":{"reason":"The model request failed due to an upstream error.
 *         Please retry.","request_id":"..."}}
 *
 * 实测同一个请求体原样重发即可成功，但 Pi 的自动重试把 400 一律视为客户端
 * 错误，于是网关抖一次就会终结整轮对话，连续多轮工具调用时几乎必然失败。
 *
 * 这里只把「400 + 上游/网关错误 + 明确要求重试」这一组合并入 Pi 的可重试
 * 判定，真正的请求参数错误仍然立即失败。命中后复用 Pi 自带的指数退避、
 * auto_retry_start/end 事件和失败消息投影剔除逻辑。
 */

const HTTP_400_PATTERN = /(^|[^0-9])400([^0-9]|$)/;
const UPSTREAM_FAILURE_PATTERN =
  /(?:upstream|provider|gateway)[\s\S]{0,160}(?:error|failed|failure|unavailable)|model request failed due to an upstream error/i;
const RETRY_HINT_PATTERN =
  /(?:please|kindly)\s+(?:retry|try again)|retry your request|try your request again|you can retry/i;

/** 是否为网关/上游临时故障伪装成的 400。 */
export const isTransientUpstreamBadRequest = (message) => {
  if (!message || message.stopReason !== "error") return false;
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (!errorMessage) return false;
  return HTTP_400_PATTERN.test(errorMessage)
    && UPSTREAM_FAILURE_PATTERN.test(errorMessage)
    && RETRY_HINT_PATTERN.test(errorMessage);
};

const INSTALLED = Symbol.for("hpp.transientProviderRetry");

/**
 * 给 AgentSession 的可重试判定补上上面这一类错误。
 *
 * `_isRetryableError` 是 Pi 的私有方法（pi-coding-agent 1.5.x），未来版本改名
 * 时这里会安全地返回 false，退回 Pi 的原始行为，不影响会话启动。
 */
export const installTransientProviderRetry = (session) => {
  const original = session?._isRetryableError;
  if (typeof original !== "function") return false;
  if (original[INSTALLED]) return true;
  const patched = function patchedIsRetryableError(message) {
    return original.call(this, message) || isTransientUpstreamBadRequest(message);
  };
  patched[INSTALLED] = true;
  try {
    session._isRetryableError = patched;
    return true;
  } catch {
    return false;
  }
};
