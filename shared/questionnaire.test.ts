import { describe, expect, it } from "vitest";
import {
  buildQuestionnaireAnswers,
  getQuestionnaireAnswerLabel,
  getQuestionnaireSummary,
  isQuestionnaireComplete,
  type QuestionnaireQuestion,
} from "./questionnaire";

const questions: QuestionnaireQuestion[] = [
  {
    id: "agent",
    question: "选择 Agent",
    options: [{ label: "Pi", value: "pi" }, { label: "Codex", value: "codex" }],
  },
  {
    id: "features",
    question: "选择功能",
    multiSelect: true,
    options: [{ label: "同步", value: "sync" }, { label: "分叉", value: "fork" }],
  },
];

describe("shared questionnaire rules", () => {
  it("builds the same structured single and multiple answers", () => {
    const answers = buildQuestionnaireAnswers(questions, { 0: ["Pi"], 1: ["同步", "分叉"] }, {});
    expect(answers[0]).toMatchObject({ kind: "option", label: "Pi", value: "pi", index: 1 });
    expect(answers[1]).toMatchObject({ kind: "multi", selected: ["同步", "分叉"], values: ["sync", "fork"] });
    expect(isQuestionnaireComplete(questions, { 0: ["Pi"], 1: ["同步", "分叉"] }, {})).toBe(true);
  });

  it("lets a custom answer replace a stale option and preserves line summaries", () => {
    const selections = { 0: ["Pi"], 1: ["同步"] };
    const custom = { 0: "自定义 Agent" };
    expect(buildQuestionnaireAnswers(questions, selections, custom)[0]).toMatchObject({
      kind: "custom",
      answer: "自定义 Agent",
      wasCustom: true,
    });
    expect(getQuestionnaireSummary(questions, selections, custom)).toBe("自定义 Agent\n同步");
  });

  it("uses one answer-label rule for interaction summaries", () => {
    expect(getQuestionnaireAnswerLabel({ label: "Pi", value: "pi" })).toBe("Pi");
    expect(getQuestionnaireAnswerLabel({ selected: ["Pi", "Codex"] })).toBe("Pi, Codex");
  });
});
