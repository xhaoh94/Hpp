import { describe, expect, it } from "vitest";
import type { RemoteInteraction } from "@shared/remote-protocol";
import { buildQuestionnaireAnswers, getQuestionnaireSummary } from "./questionnaire";

describe("mobile questionnaire answers", () => {
  it("preserves a single option's label, value, and one-based index", () => {
    const questions: RemoteInteraction["questions"] = [{
      id: "height",
      question: "输入区采用哪种默认高度？",
      options: [
        { label: "紧凑", value: "compact" },
        { label: "宽松", value: "comfortable" },
      ],
    }];

    expect(buildQuestionnaireAnswers(questions, { 0: ["紧凑"] }, {})).toEqual([{
      id: "height",
      questionIndex: 0,
      question: "输入区采用哪种默认高度？",
      kind: "option",
      answer: "compact",
      value: "compact",
      label: "紧凑",
      wasCustom: false,
      index: 1,
      selectedOption: { label: "紧凑", value: "compact" },
    }]);
  });

  it("submits only the selected multi-choice option", () => {
    const questions: RemoteInteraction["questions"] = [{
      id: "agents",
      question: "常用 Agent",
      multiSelect: true,
      options: [
        { label: "Pi", value: "pi" },
        { label: "Claude Code", value: "claude" },
        { label: "Codex", value: "codex" },
        { label: "Gemini CLI", value: "gemini" },
      ],
    }];

    const [answer] = buildQuestionnaireAnswers(questions, { 0: ["Pi"] }, {});
    expect(answer).toMatchObject({
      kind: "multi",
      selected: ["Pi"],
      values: ["pi"],
      selectedOptions: [{ label: "Pi", value: "pi" }],
    });
  });

  it("uses a custom answer instead of a stale preset selection", () => {
    const questions: RemoteInteraction["questions"] = [{
      question: "修改效果如何？",
      options: [{ label: "正常", value: "normal" }],
    }];

    expect(buildQuestionnaireAnswers(questions, { 0: ["正常"] }, { 0: "测试" })).toEqual([{
      id: "question-1",
      questionIndex: 0,
      question: "修改效果如何？",
      kind: "custom",
      answer: "测试",
      value: "测试",
      label: "测试",
      wasCustom: true,
    }]);
    expect(getQuestionnaireSummary(questions, { 0: ["正常"] }, { 0: "测试" })).toBe("测试");
  });
});
