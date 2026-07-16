import { describe, expect, it } from "vitest";
import { formatModelSwitchToastText } from "./model-switch";

describe("model switch toast", () => {
  it("includes the provider for agents that activate one provider at a time", () => {
    expect(formatModelSwitchToastText(true, "openai", "GPT-5.6"))
      .toBe("已切换至 GPT-5.6（openai 渠道）");
  });

  it("matches the compact desktop message for ordinary agents", () => {
    expect(formatModelSwitchToastText(false, "openai", "GPT-5.6"))
      .toBe("已切换至 GPT-5.6");
  });
});
