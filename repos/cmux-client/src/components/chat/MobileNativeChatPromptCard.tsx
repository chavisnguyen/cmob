import { useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Loader2,
  MessageSquareMore,
  PenLine,
  Send,
  X,
} from "lucide-react";
import type { AwaitingInput } from "../../protocol/event";
import { shouldSubmitComposerKey } from "./composerKey";
import { NativeChatProse } from "./NativeChatProse";
import {
  EMPTY_STEP_DRAFT,
  buildStepAnswer,
  buildWizardSubmission,
  normalizePromptSteps,
  type QuestionAnswerPayload,
  type QuestionStepAnswer,
  type StepDraft,
} from "./promptCardModel";

export type { QuestionAnswerPayload, QuestionStepAnswer };

interface MobileNativeChatPromptCardProps {
  awaiting: AwaitingInput;
  isDesktop?: boolean;
  onAnswer: (payload: QuestionAnswerPayload) => Promise<void>;
  onCancel?: () => Promise<void>;
}

export function MobileNativeChatPromptCard({
  awaiting,
  isDesktop = false,
  onAnswer,
  onCancel,
}: MobileNativeChatPromptCardProps) {
  const steps = useMemo(() => normalizePromptSteps(awaiting), [awaiting]);
  const totalSteps = steps.length;
  const [collapsed, setCollapsed] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, StepDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const lastCompositionEndRef = useRef(0);

  const activeStep = steps[Math.min(stepIndex, totalSteps - 1)];
  const currentDraft = drafts[stepIndex] ?? EMPTY_STEP_DRAFT;
  const { selectedIndices, isOtherOpen, otherText } = currentDraft;

  const updateDraft = (patch: Partial<StepDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [stepIndex]: { ...(prev[stepIndex] ?? EMPTY_STEP_DRAFT), ...patch },
    }));
  };

  const options = activeStep.options ?? [];
  const isMulti = activeStep.multi_select === true;
  const freeTextOnly = options.length === 0;
  const isLastStep = stepIndex >= totalSteps - 1;

  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="prompt-strip"
        onClick={() => setCollapsed(false)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-line-strong bg-surface hover:bg-raised text-left transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <MessageSquareMore className="w-3.5 h-3.5 text-status-wait shrink-0" />
          <span className="text-[12.5px] font-medium text-fg truncate">
            {activeStep.question || awaiting.prompt || "Question awaiting your answer"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-medium text-fg-soft shrink-0">
          {totalSteps > 1 && (
            <span className="font-mono text-muted">
              {stepIndex + 1}/{totalSteps} ·{" "}
            </span>
          )}
          <span>Answer</span>
          <ChevronUp className="w-3.5 h-3.5" />
        </div>
      </button>
    );
  }

  const commitStepOrSubmit = async (indices: number[], customText?: string) => {
    if (submitting) return;
    const currentAnswer = buildStepAnswer(activeStep, indices, customText);
    if (!currentAnswer) return;

    const nextDrafts: Record<number, StepDraft> = {
      ...drafts,
      [stepIndex]: {
        selectedIndices: indices,
        isOtherOpen: Boolean(customText?.trim()),
        otherText: customText ?? "",
      },
    };
    setDrafts(nextDrafts);

    if (!isLastStep) {
      setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
      return;
    }

    setSubmitting(true);
    try {
      await onAnswer(buildWizardSubmission(steps, stepIndex, currentAnswer, nextDrafts));
    } finally {
      setSubmitting(false);
    }
  };

  const handleOptionPress = (idx: number) => {
    if (submitting) return;
    if (isMulti) {
      const nextIndices = selectedIndices.includes(idx)
        ? selectedIndices.filter((i) => i !== idx)
        : [...selectedIndices, idx];
      updateDraft({ selectedIndices: nextIndices });
      return;
    }
    updateDraft({ selectedIndices: [idx], isOtherOpen: false });
    void commitStepOrSubmit([idx]);
  };

  const canSubmitManual =
    (isMulti && (selectedIndices.length > 0 || (isOtherOpen && otherText.trim().length > 0))) ||
    ((isOtherOpen || freeTextOnly) && otherText.trim().length > 0);

  return (
    <div
      role="region"
      aria-label="Agent question"
      data-testid="docked-prompt-card"
      className="rounded-lg border border-line-strong bg-surface overflow-hidden"
    >
      <div className="flex items-start justify-between gap-2 px-3 py-2 bg-sidebar border-b border-line">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {stepIndex > 0 ? (
            <button
              type="button"
              disabled={submitting}
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              aria-label="Previous question"
              className="w-6 h-6 -ml-1 rounded-[5px] hover:bg-raised text-fg-soft flex items-center justify-center shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          ) : (
            <MessageSquareMore className="w-3.5 h-3.5 text-status-wait shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              <span>{isMulti ? "Select all that apply" : "Question"}</span>
              {totalSteps > 1 && (
                <span className="px-1.5 py-0.2 rounded bg-raised text-fg-soft font-mono tabular-nums">
                  {stepIndex + 1}/{totalSteps}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[13px] font-medium text-fg leading-snug">
              <NativeChatProse content={activeStep.question || awaiting.prompt} compact />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Minimize question"
            aria-label="Minimize question"
            className="w-6 h-6 rounded-[5px] hover:bg-raised text-muted hover:text-fg flex items-center justify-center transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {onCancel && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void onCancel()}
              title="Skip / Cancel"
              aria-label="Cancel question"
              className="w-6 h-6 rounded-[5px] hover:bg-status-err/15 text-muted hover:text-status-err flex items-center justify-center transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="p-2 space-y-1 max-h-[44vh] overflow-y-auto scrollbar-sleek">
        {options.map((opt, idx) => {
          const selected = selectedIndices.includes(idx);
          return (
            <button
              key={`q-opt-${stepIndex}-${idx}`}
              type="button"
              disabled={submitting}
              onClick={() => handleOptionPress(idx)}
              className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md border text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "bg-accent/10 border-accent/55 text-fg"
                  : "bg-sidebar/70 hover:bg-raised/60 border-line text-fg-soft"
              }`}
            >
              <span
                className={`mt-0.5 text-[11px] font-mono tabular-nums shrink-0 w-4 text-right ${
                  selected ? "text-accent-soft font-semibold" : "text-dim"
                }`}
              >
                {idx + 1}.
              </span>
              <span className="flex-1 min-w-0 text-[12.5px] leading-snug break-words">
                <NativeChatProse content={opt} compact />
              </span>
              {isMulti ? (
                <span
                  className={`mt-0.5 w-4 h-4 rounded-[4px] flex items-center justify-center border shrink-0 ${
                    selected ? "bg-accent border-accent text-bg" : "border-line-strong"
                  }`}
                >
                  {selected && <Check className="w-3 h-3 stroke-[3]" />}
                </span>
              ) : (
                selected &&
                submitting && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-fg mt-0.5 shrink-0" />
                )
              )}
            </button>
          );
        })}

        {options.length > 0 && (
          <button
            type="button"
            disabled={submitting}
            onClick={() =>
              updateDraft({
                isOtherOpen: !isOtherOpen,
                ...(isMulti ? {} : { selectedIndices: [] }),
              })
            }
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-left transition-colors ${
              isOtherOpen
                ? "bg-raised border-line-strong text-fg"
                : "bg-transparent hover:bg-sidebar border-line text-muted"
            }`}
          >
            <PenLine className="w-3 h-3 text-dim shrink-0 ml-0.5" />
            <span className="text-[12px] font-medium">Write-in / Other…</span>
          </button>
        )}

        {(isOtherOpen || freeTextOnly) && (
          <div className="pt-1 flex items-end gap-1.5">
            <textarea
              value={otherText}
              onChange={(e) => updateDraft({ otherText: e.target.value })}
              onCompositionEnd={() => {
                lastCompositionEndRef.current =
                  typeof performance !== "undefined" ? performance.now() : Date.now();
              }}
              onKeyDown={(e) => {
                if (
                  shouldSubmitComposerKey({
                    key: e.key,
                    shiftKey: e.shiftKey,
                    isComposing: e.nativeEvent.isComposing,
                    keyCode: e.keyCode,
                    isDesktop,
                    hasSlashMenu: false,
                    lastCompositionEndAt: lastCompositionEndRef.current,
                  })
                ) {
                  e.preventDefault();
                  if (otherText.trim()) {
                    void commitStepOrSubmit(isMulti ? selectedIndices : [], otherText);
                  }
                }
              }}
              placeholder="Type your custom answer…"
              rows={2}
              autoFocus
              className="flex-1 bg-bg border border-line-strong rounded-md px-2.5 py-1.5 text-[12.5px] text-fg placeholder-dim focus:outline-none focus:border-accent/65 resize-none font-sans"
            />
            {!isMulti && (
              <button
                type="button"
                disabled={submitting || !otherText.trim()}
                onClick={() => void commitStepOrSubmit([], otherText)}
                className="h-8 px-3 rounded-md bg-accent hover:bg-accent-strong text-bg font-medium text-[12px] flex items-center gap-1.5 shrink-0 disabled:opacity-40 transition-colors"
              >
                {submitting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Send className="w-3 h-3" />
                )}
                <span>{isLastStep ? "Send" : "Next"}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {isMulti && (
        <div className="px-2.5 py-2 border-t border-line flex justify-end">
          <button
            type="button"
            disabled={submitting || !canSubmitManual}
            onClick={() =>
              void commitStepOrSubmit(selectedIndices, isOtherOpen ? otherText : undefined)
            }
            className="h-7 px-3 rounded-md bg-accent hover:bg-accent-strong text-bg font-medium text-[12px] flex items-center gap-1.5 disabled:opacity-40 transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Send className="w-3 h-3" />
            )}
            <span>{isLastStep ? "Submit" : "Next"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
