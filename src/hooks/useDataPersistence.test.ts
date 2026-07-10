import { afterEach, describe, expect, it } from "vitest";
import { useChatStore, type ModelInfo } from "@/stores/chat-store";
import { selectSessionModel } from "./useDataPersistence";

const models: ModelInfo[] = [
  { id: "default-model", name: "Default", provider: "default-provider", reasoning: true },
  { id: "current-model", name: "Current", provider: "current-provider", reasoning: true },
];

describe("selectSessionModel", () => {
  afterEach(() => {
    useChatStore.setState({ currentModel: null });
  });

  it("inherits the currently selected provider and model for a new session", () => {
    useChatStore.setState({ currentModel: models[1] });

    expect(selectSessionModel("new-session-without-persisted-model", models)).toEqual(models[1]);
  });

  it("falls back to the first available model when the current model is unavailable", () => {
    useChatStore.setState({
      currentModel: { id: "missing", name: "Missing", provider: "missing-provider", reasoning: true },
    });

    expect(selectSessionModel("new-session-with-missing-model", models)).toEqual(models[0]);
  });
});
