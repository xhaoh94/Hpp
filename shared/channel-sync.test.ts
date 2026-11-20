import { describe, expect, it } from "vitest";
import {
  CHANNEL_SYNC_DEFAULT_DEPLOY_PATH,
  CHANNEL_SYNC_DEFAULT_DEPLOY_PATH_IS_GENERIC,
  countChannelSyncProviders,
  describeChannelSyncNetworkError,
  describeChannelSyncStatus,
  formatChannelSyncTimestamp,
  maskChannelSyncToken,
  normalizeChannelSyncBaseUrl,
  validateChannelSyncTargetInput,
} from "./channel-sync";
import type { AgentConfigExportData } from "./agent-config-io";

const createExport = (agents: AgentConfigExportData["agents"]): AgentConfigExportData => ({
  type: "hpp-agent-config-export",
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  includeApiKeys: true,
  agents,
});

describe("normalizeChannelSyncBaseUrl", () => {
  it("接受 http 地址并去掉末尾斜杠", () => {
    expect(normalizeChannelSyncBaseUrl("http://100.64.0.7:8787/")).toEqual({
      ok: true,
      value: "http://100.64.0.7:8787",
    });
  });

  it("保留反向代理的子路径，但去掉末尾斜杠", () => {
    expect(normalizeChannelSyncBaseUrl("  https://nas.example.com/hpp//  ")).toEqual({
      ok: true,
      value: "https://nas.example.com/hpp",
    });
  });

  it("拒绝缺少协议的输入", () => {
    const result = normalizeChannelSyncBaseUrl("100.64.0.7:8787");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("http://");
  });

  it("拒绝空地址和带查询参数的地址", () => {
    expect(normalizeChannelSyncBaseUrl("   ").ok).toBe(false);
    expect(normalizeChannelSyncBaseUrl("http://nas:8787/?x=1").ok).toBe(false);
  });

  it("拒绝非 http(s) 协议", () => {
    expect(normalizeChannelSyncBaseUrl("ftp://nas:8787").ok).toBe(false);
  });
});

describe("默认部署目录", () => {
  it("用通用 Linux 路径，不绑定某台 NAS 的私有目录", () => {
    expect(CHANNEL_SYNC_DEFAULT_DEPLOY_PATH).toBe("/opt/hpp-channel-sync");
    expect(CHANNEL_SYNC_DEFAULT_DEPLOY_PATH_IS_GENERIC).toBe(true);
  });

  it("不传 deployPath 时落到默认值", () => {
    const result = validateChannelSyncTargetInput({ host: "nas", sshUser: "root" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.deployPath).toBe("/opt/hpp-channel-sync");
  });
});

describe("maskChannelSyncToken", () => {
  it("短 token 全部打码", () => {
    expect(maskChannelSyncToken("abc123")).toBe("••••••");
  });

  it("长 token 只保留头尾", () => {
    const masked = maskChannelSyncToken("0123456789abcdef0123456789abcdef");
    expect(masked.startsWith("0123")).toBe(true);
    expect(masked.endsWith("ef")).toBe(true);
    expect(masked).not.toContain("456789");
  });

  it("空值返回空串", () => {
    expect(maskChannelSyncToken("  ")).toBe("");
  });
});

describe("countChannelSyncProviders", () => {
  it("统计 Agent 与渠道数量", () => {
    const data = createExport({
      pi: { providers: [{ providerId: "a" }, { providerId: "b" }] } as never,
      claude: { providers: [{ providerId: "c" }] } as never,
    });
    expect(countChannelSyncProviders(data)).toEqual({ agentCount: 2, providerCount: 3 });
  });

  it("空包统计为 0", () => {
    expect(countChannelSyncProviders(createExport({}))).toEqual({ agentCount: 0, providerCount: 0 });
  });
});

describe("错误文案", () => {
  it("把常见网络错误翻译成可操作提示", () => {
    expect(describeChannelSyncNetworkError(new Error("connect ECONNREFUSED 10.0.0.2:8787"))).toContain("连接被拒绝");
    expect(describeChannelSyncNetworkError(new Error("getaddrinfo ENOTFOUND nas"))).toContain("解析失败");
    expect(describeChannelSyncNetworkError(new Error("This operation was aborted"))).toContain("超时");
  });

  it("HTTP 状态码给出具体下一步", () => {
    expect(describeChannelSyncStatus(401)).toContain("Token");
    expect(describeChannelSyncStatus(404)).toContain("还没有备份");
    expect(describeChannelSyncStatus(500)).toContain("容器日志");
  });
});

describe("formatChannelSyncTimestamp", () => {
  it("把 ISO 时间格式化为本地时间", () => {
    const formatted = formatChannelSyncTimestamp("2026-03-04T05:06:07.000Z");
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("空值或非法值原样处理", () => {
    expect(formatChannelSyncTimestamp()).toBe("");
    expect(formatChannelSyncTimestamp("not-a-date")).toBe("not-a-date");
  });
});
