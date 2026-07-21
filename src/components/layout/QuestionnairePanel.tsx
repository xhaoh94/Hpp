import { useState } from "react";
import {
  buildQuestionnaireAnswers,
  getQuestionnaireAnswerLabel,
  isQuestionnaireComplete,
  type QuestionnaireOption,
  type QuestionnaireQuestion,
} from "@shared/questionnaire";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): UnknownRecord =>
  isRecord(value) ? value : {};

const getStringField = (value: UnknownRecord, key: string): string | undefined => {
  const found = value[key];
  return typeof found === "string" ? found : undefined;
};

export type AskQuestionOption = QuestionnaireOption;
export type AskQuestionPayload = QuestionnaireQuestion;

const getNestedQuestionValue = (value: unknown, path: string[]): unknown => {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

const readFirstQuestionValue = (value: unknown, paths: string[][]): unknown => {
  for (const path of paths) {
    const found = getNestedQuestionValue(value, path);
    if (found !== undefined && found !== null && found !== "") return found;
  }
  return undefined;
};

const parseJsonQuestionValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const normalizeAskOptions = (value: unknown): AskQuestionOption[] => {
  if (!Array.isArray(value)) return [];
  return value.map((option, index) => {
    if (typeof option === "string") return { label: option, value: option };
    const raw = asRecord(option);
    return {
      label: String(raw.label ?? raw.value ?? raw.text ?? raw.title ?? `选项 ${index + 1}`),
      value: raw.value === undefined || raw.value === null ? undefined : String(raw.value),
      description: typeof raw.description === "string" ? raw.description : undefined,
      preview: typeof raw.preview === "string" ? raw.preview : undefined,
      hasPreview: !!raw.hasPreview,
    };
  });
};

const normalizeAskQuestions = (value: unknown): AskQuestionPayload[] => {
  const parsedValue = parseJsonQuestionValue(value);
  const rawQuestions = Array.isArray(parsedValue)
    ? parsedValue
    : isRecord(parsedValue) && Array.isArray(parsedValue.questions)
      ? parsedValue.questions
      : [];

  if (rawQuestions.length === 0 && isRecord(parsedValue)) {
    const raw = parsedValue;
    const detail = asRecord(raw.detail);
    const params = asRecord(raw.params);
    const question = readFirstQuestionValue(raw, [
      ["question"],
      ["title"],
      ["prompt"],
      ["message"],
      ["placeholder"],
      ["detail", "question"],
      ["detail", "title"],
      ["detail", "prompt"],
      ["detail", "message"],
      ["params", "question"],
      ["params", "prompt"],
      ["params", "message"],
    ]);
    const options = readFirstQuestionValue(raw, [
      ["options"],
      ["choices"],
      ["items"],
      ["detail", "options"],
      ["detail", "choices"],
      ["params", "options"],
      ["params", "choices"],
    ]);
    if (question || Array.isArray(options)) {
      return [{
        id: getStringField(raw, "id"),
        question: String(question || "请选择答案"),
        header: getStringField(raw, "header"),
        multiSelect: !!(raw.multiSelect ?? raw.multiple ?? detail.multiSelect ?? params.multiSelect),
        options: normalizeAskOptions(options),
      }];
    }
  }

  if (rawQuestions.length === 0 && typeof parsedValue === "string" && parsedValue.trim()) {
    return [{ question: parsedValue.trim(), options: [] }];
  }

  return rawQuestions.map((value, questionIndex) => {
    const raw = asRecord(value);
    const options = normalizeAskOptions(raw.options ?? raw.choices);
    return {
      id: getStringField(raw, "id"),
      question: String(raw.question ?? raw.prompt ?? raw.title ?? raw.message ?? `问题 ${questionIndex + 1}`),
      header: getStringField(raw, "label") ?? getStringField(raw, "header"),
      multiSelect: !!(raw.multiSelect ?? raw.multiple),
      options,
    };
  });
};

export const normalizeAskQuestionsFromCandidates = (...values: unknown[]): AskQuestionPayload[] => {
  for (const value of values) {
    const questions = normalizeAskQuestions(value);
    if (questions.length > 0) return questions;
  }

  const optionSource = values.find((value) => {
    const raw = asRecord(value);
    const detail = asRecord(raw.detail);
    const params = asRecord(raw.params);
    return Array.isArray(raw.options) ||
      Array.isArray(raw.choices) ||
      Array.isArray(detail.options) ||
      Array.isArray(params.options);
  });
  const promptSource = values.find((value) => {
    if (typeof value === "string") return true;
    const raw = asRecord(value);
    const detail = asRecord(raw.detail);
    return typeof raw.question === "string" ||
      typeof raw.prompt === "string" ||
      typeof raw.message === "string" ||
      typeof raw.title === "string" ||
      typeof detail.question === "string" ||
      typeof detail.prompt === "string" ||
      typeof detail.message === "string" ||
      typeof detail.title === "string";
  });

  const question = typeof promptSource === "string"
    ? promptSource
    : readFirstQuestionValue(promptSource, [
        ["question"],
        ["prompt"],
        ["message"],
        ["title"],
        ["detail", "question"],
        ["detail", "prompt"],
        ["detail", "message"],
        ["detail", "title"],
      ]);
  const options = readFirstQuestionValue(optionSource, [
    ["options"],
    ["choices"],
    ["detail", "options"],
    ["detail", "choices"],
    ["params", "options"],
    ["params", "choices"],
  ]);

  if (question || Array.isArray(options)) {
    return [{
      question: String(question || "请选择答案"),
      options: normalizeAskOptions(options),
    }];
  }

  return [];
};

export { getQuestionnaireAnswerLabel };

export function QuestionnairePanel({
  questions,
  onSubmit,
  onCancel,
}: {
  questions: AskQuestionPayload[];
  onSubmit: (answers: unknown[]) => void;
  onCancel: () => void;
}) {
  const [singleChoice, setSingleChoice] = useState<Record<number, string>>({});
  const [multiChoice, setMultiChoice] = useState<Record<number, string[]>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  const selections = Object.fromEntries(questions.map((question, questionIndex) => [
    questionIndex,
    question.multiSelect
      ? multiChoice[questionIndex] || []
      : singleChoice[questionIndex] ? [singleChoice[questionIndex]] : [],
  ]));
  const hasAnswer = isQuestionnaireComplete(questions, selections, customText);

  return (
    <div className="chat-questionnaire">
      <div className="chat-questionnaire-header">
        <span>需要你的选择</span>
        <button type="button" onClick={onCancel}>取消</button>
      </div>
      <div className="chat-questionnaire-list">
        {questions.map((question, questionIndex) => (
          <div className="chat-questionnaire-question" key={`${question.question}-${questionIndex}`}>
            <div className="chat-questionnaire-title">
              {question.header && <span>{question.header}</span>}
              <strong>{question.question}</strong>
            </div>
            {!!question.options?.length && (
              <div className="chat-questionnaire-options">
                {question.options.map((option) => {
                  const checked = question.multiSelect
                    ? (multiChoice[questionIndex] || []).includes(option.label)
                    : singleChoice[questionIndex] === option.label;
                  return (
                    <button
                      type="button"
                      key={option.label}
                      className={`chat-questionnaire-option ${checked ? "selected" : ""}`}
                      onClick={() => {
                        setCustomText((current) => ({ ...current, [questionIndex]: "" }));
                        if (question.multiSelect) {
                          setMultiChoice((current) => {
                            const previous = current[questionIndex] || [];
                            return {
                              ...current,
                              [questionIndex]: previous.includes(option.label)
                                ? previous.filter((item) => item !== option.label)
                                : [...previous, option.label],
                            };
                          });
                        } else {
                          setSingleChoice((current) => ({ ...current, [questionIndex]: option.label }));
                        }
                      }}
                    >
                      <span className="chat-questionnaire-mark" />
                      <span className="chat-questionnaire-option-text">
                        <span>{option.label}</span>
                        {option.description && <small>{option.description}</small>}
                        {option.preview && <pre>{option.preview}</pre>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {!question.multiSelect && (
              <textarea
                className="chat-questionnaire-custom"
                rows={2}
                placeholder="自定义回答"
                value={customText[questionIndex] || ""}
                onFocus={() => {
                  setSingleChoice((current) => ({ ...current, [questionIndex]: "" }));
                  setMultiChoice((current) => ({ ...current, [questionIndex]: [] }));
                }}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomText((current) => ({ ...current, [questionIndex]: value }));
                  if (value.trim()) {
                    setSingleChoice((current) => ({ ...current, [questionIndex]: "" }));
                    setMultiChoice((current) => ({ ...current, [questionIndex]: [] }));
                  }
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="chat-questionnaire-actions">
        <button type="button" onClick={() => onSubmit(buildQuestionnaireAnswers(questions, selections, customText))} disabled={!hasAnswer}>
          提交回答
        </button>
      </div>
    </div>
  );
}
