export type QuestionnaireOption = {
  label: string;
  value?: string;
  description?: string;
  preview?: string;
  hasPreview?: boolean;
};

export type QuestionnaireQuestion = {
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionnaireOption[];
};

export type QuestionnaireSelections = Record<number, string[]>;
export type QuestionnaireCustomAnswers = Record<number, string>;

export function buildQuestionnaireAnswers(
  questions: QuestionnaireQuestion[],
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

export function isQuestionnaireComplete(
  questions: QuestionnaireQuestion[],
  selections: QuestionnaireSelections,
  customAnswers: QuestionnaireCustomAnswers,
) {
  return questions.every((question, questionIndex) => {
    if (customAnswers[questionIndex]?.trim()) return true;
    const selected = selections[questionIndex] || [];
    return question.multiSelect ? selected.length > 0 : !!selected[0];
  });
}

export function getQuestionnaireSummary(
  questions: QuestionnaireQuestion[],
  selections: QuestionnaireSelections,
  customAnswers: QuestionnaireCustomAnswers,
) {
  return questions
    .map((_question, index) => customAnswers[index]?.trim() || (selections[index] || []).join(", "))
    .filter(Boolean)
    .join("\n");
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function getQuestionnaireAnswerLabel(answer: unknown) {
  const raw = asRecord(answer);
  if (typeof raw.label === "string") return raw.label;
  if (typeof raw.answer === "string") return raw.answer;
  if (Array.isArray(raw.selected)) return raw.selected.map(String).join(", ");
  if (typeof raw.value === "string") return raw.value;
  return "";
}
