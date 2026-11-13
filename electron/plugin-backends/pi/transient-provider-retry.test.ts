import { describe, expect, it } from "vitest";
import {
  installTransientProviderRetry,
  isTransientUpstreamBadRequest,
} from "./transient-provider-retry.mjs";

const EDGEFN_400 = `400: {"code":400,"reason":"InvalidRequestBody","message":"无效的请求参数.","metadata":{"reason":"The model request failed due to an upstream error. Please retry.","request_id":"202611132211289932060991610630"}}`;

const errorMessage = (message, stopReason = "error") => ({ stopReason, errorMessage: message });

describe("isTransientUpstreamBadRequest", () => {
  it("识别 edgefn 把上游故障包装成的 400", () => {
    expect(isTransientUpstreamBadRequest(errorMessage(EDGEFN_400))).toBe(true);
  });

  it("不依赖 400 前缀，兼容带 HTTP 字样的错误", () => {
    expect(
      isTransientUpstreamBadRequest(
        errorMessage(`HTTP 400: The model request failed due to an upstream error. Please retry.`),
      ),
    ).toBe(true);
  });

  it("真正的请求参数错误仍然不可重试", () => {
    expect(
      isTransientUpstreamBadRequest(
        errorMessage(`400: {"error":{"message":"messages[1].content must be a string"}}`),
      ),
    ).toBe(false);
  });

  it("没有重试提示时不猜测", () => {
    expect(
      isTransientUpstreamBadRequest(
        errorMessage(`400: {"reason":"InvalidRequestBody","metadata":{"reason":"upstream error"}}`),
      ),
    ).toBe(false);
  });

  it("非 400 或非 error 消息不接管", () => {
    expect(
      isTransientUpstreamBadRequest(
        errorMessage(`429: upstream error. Please retry.`),
      ),
    ).toBe(false);
    expect(
      isTransientUpstreamBadRequest(
        errorMessage(`400: upstream error. Please retry.`, "stop"),
      ),
    ).toBe(false);
  });
});

describe("installTransientProviderRetry", () => {
  it("保留 Pi 原有的可重试判定，并补充网络上游 400", () => {
    const session = {
      _isRetryableError(message) {
        return message.stopReason === "error" && /server error/i.test(message.errorMessage || "");
      },
    };
    expect(installTransientProviderRetry(session)).toBe(true);
    expect(session._isRetryableError(errorMessage("500: server error"))).toBe(true);
    expect(session._isRetryableError(errorMessage(EDGEFN_400))).toBe(true);
    expect(session._isRetryableError(errorMessage("400: invalid body"))).toBe(false);
  });

  it("重复安装不会叠加包装", () => {
    let calls = 0;
    const session = {
      _isRetryableError() {
        calls += 1;
        return false;
      },
    };
    installTransientProviderRetry(session);
    installTransientProviderRetry(session);
    expect(session._isRetryableError(errorMessage(EDGEFN_400))).toBe(true);
    expect(calls).toBe(1);
  });

  it("SDK 没有该私有方法时安全跳过", () => {
    expect(installTransientProviderRetry({})).toBe(false);
    expect(installTransientProviderRetry(null)).toBe(false);
  });
});
