import type { RemoteInteraction } from "@shared/remote-protocol";

type QuestionnaireSelections = Record<number, string[]>;
type QuestionnaireCustomAnswers = Record<number, string>;

export function buildQuestionnaireAnswers(
  questions: RemoteInteraction["questions"],
  selections: QuestionnaireSelections,
  customAnswers: QuestionnaireCustomAnswers,
) {
  return questions.map((question, questionIndex) => {
    const custom = customAnswers[questionIndex]?.trim();
    if (custom) {
      return {
        id: question.id || `question-${questionIndex + 1}`,
        questionIndex,
        question: question.question,
        kind: "custom",
        answer: custom,
        value: custom,
        label: custom,
        wasCustom: true,
      };
    }

    if (question.multiSelect) {
      const selectedLabels = selections[questionIndex] || [];
      const selectedOptions = (question.options || []).filter((option) => selectedLabels.includes(option.label));
      return {
        id: question.id || `question-${questionIndex + 1}`,
        questionIndex,
        question: question.question,
        kind: "multi",
        answer: null,
        selected: selectedLabels,
        selectedOptions,
        values: selectedOptions.map((option) => option.value ?? option.label),
      };
    }

    const selectedLabel = selections[questionIndex]?.[0] || null;
    const selectedOption = selectedLabel
      ? question.options?.find((option) => option.label === selectedLabel)
      : undefined;
    return {
      id: question.id || `question-${questionIndex + 1}`,
      questionIndex,
      question: question.question,
      kind: "option",
      answer: selectedOption?.value ?? selectedLabel,
      value: selectedOption?.value ?? selectedLabel,
      label: selectedLabel,
      wasCustom: false,
      index: selectedOption
        ? (question.options || []).findIndex((option) => option.label === selectedOption.label) + 1
        : undefined,
      selectedOption,
    };
  });
}
export function getQuestionnaireSummary(
  questions: RemoteInteraction["questions"],
  selections: QuestionnaireSelections,
  customAnswers: QuestionnaireCustomAnswers,
) {
  return questions
    .map((_question, index) => customAnswers[index]?.trim() || (selections[index] || []).join(", "))
    .filter(Boolean)
    .join("\n");
}
