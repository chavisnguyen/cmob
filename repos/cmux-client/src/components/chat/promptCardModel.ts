import type { AskQuestionItem, AwaitingInput } from "../../protocol/event";

export interface QuestionStepAnswer {
  indices: number[];
  other?: string;
  optionCount: number;
  multiSelect: boolean;
  displayText: string;
}

export interface QuestionAnswerPayload extends QuestionStepAnswer {
  /** Populated when answering a multi-question wizard (`awaiting.questions.length > 1`). */
  steps?: QuestionStepAnswer[];
}

export interface StepDraft {
  selectedIndices: number[];
  isOtherOpen: boolean;
  otherText: string;
}

export const EMPTY_STEP_DRAFT: StepDraft = {
  selectedIndices: [],
  isOtherOpen: false,
  otherText: "",
};

export function normalizePromptSteps(awaiting: AwaitingInput): AskQuestionItem[] {
  if (awaiting.questions && awaiting.questions.length > 0) {
    return awaiting.questions;
  }
  return [
    {
      question: awaiting.prompt,
      options: awaiting.options ?? [],
      multi_select: awaiting.multi_select,
    },
  ];
}

export function buildStepAnswer(
  step: AskQuestionItem,
  indices: number[],
  customText?: string,
): QuestionStepAnswer | null {
  const trimmedOther = (customText ?? "").trim();
  if (indices.length === 0 && !trimmedOther) return null;
  const opts = step.options ?? [];
  const labels = indices.map((i) => opts[i]).filter(Boolean);
  const displayParts = [...labels, ...(trimmedOther ? [trimmedOther] : [])];
  return {
    indices,
    ...(trimmedOther ? { other: trimmedOther } : {}),
    optionCount: opts.length,
    multiSelect: step.multi_select === true,
    displayText: displayParts.join(", "),
  };
}

export function buildWizardSubmission(
  steps: readonly AskQuestionItem[],
  stepIndex: number,
  currentAnswer: QuestionStepAnswer,
  drafts: Record<number, StepDraft>,
): QuestionAnswerPayload {
  if (steps.length <= 1) return currentAnswer;
  const allAnswers: QuestionStepAnswer[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    if (i === stepIndex) {
      allAnswers.push(currentAnswer);
    } else {
      const d = drafts[i];
      const built = d
        ? buildStepAnswer(steps[i], d.selectedIndices, d.isOtherOpen ? d.otherText : undefined)
        : null;
      if (built) allAnswers.push(built);
    }
  }
  return {
    ...currentAnswer,
    displayText: allAnswers.map((a, idx) => `Q${idx + 1}: ${a.displayText}`).join(" · "),
    steps: allAnswers,
  };
}
