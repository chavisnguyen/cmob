/**
 * Orca-style Docked Question Prompt Card & Collapsible Strip
 *
 * Rises above the chat composer when an agent asks a structured question (`ask_question` / `AskUserQuestion`):
 * - Single-select options submit on tap (`autoAdvance`) using option indices so TUI selectors navigate cleanly.
 * - Multi-select options toggle checkmarks and submit together.
 * - `Write-in / Other…` opens a focused free-text box.
 * - Collapses into a 1-line `PromptStrip` when the reader wants full viewport room to read history.
 *
 * Sources:
 * - ref/orca/mobile/src/session/native-chat/input/MobileNativeChatPromptCard.tsx
 * - ref/orca/mobile/src/session/native-chat/input/MobileNativeChatAsk.tsx
 * - ref/orca/mobile/src/session/native-chat/input/MobileNativeChatPromptStrip.tsx
 */

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageSquareMore,
  PenLine,
  Send,
  X,
} from "lucide-react";
import type { AwaitingInput } from "../../protocol/event";
import { NativeChatProse } from "./NativeChatProse";

export interface QuestionAnswerPayload {
  indices: number[];
  other?: string;
  optionCount: number;
  multiSelect: boolean;
  displayText: string;
}

interface MobileNativeChatPromptCardProps {
  awaiting: AwaitingInput;
  onAnswer: (payload: QuestionAnswerPayload) => Promise<void>;
  onCancel?: () => Promise<void>;
}

export function MobileNativeChatPromptCard({
  awaiting,
  onAnswer,
  onCancel,
}: MobileNativeChatPromptCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [isOtherOpen, setIsOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const options = awaiting.options ?? [];
  const isMulti = awaiting.multi_select === true;
  const freeTextOnly = options.length === 0;

  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="prompt-strip"
        onClick={() => setCollapsed(false)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-accent/35 bg-accent/10 hover:bg-accent/15 text-left transition-colors shadow-sm"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <MessageSquareMore className="w-4 h-4 text-accent-soft shrink-0" />
          <span className="text-xs font-medium text-fg truncate">
            {awaiting.prompt || "Question awaiting your answer"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-semibold text-accent-soft shrink-0">
          <span>Answer</span>
          <ChevronUp className="w-3.5 h-3.5" />
        </div>
      </button>
    );
  }

  const submitPayload = async (indices: number[], customText?: string) => {
    if (submitting) return;
    const trimmedOther = (customText ?? "").trim();
    if (indices.length === 0 && !trimmedOther) return;

    const labels = indices.map((i) => options[i]).filter(Boolean);
    const displayParts = [...labels, ...(trimmedOther ? [trimmedOther] : [])];

    setSubmitting(true);
    try {
      await onAnswer({
        indices,
        ...(trimmedOther ? { other: trimmedOther } : {}),
        optionCount: options.length,
        multiSelect: isMulti,
        displayText: displayParts.join(", "),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleOptionPress = (idx: number) => {
    if (submitting) return;
    if (isMulti) {
      setSelectedIndices((prev) =>
        prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
      );
      return;
    }
    setSelectedIndices([idx]);
    setIsOtherOpen(false);
    void submitPayload([idx]);
  };

  const canSubmitManual =
    (isMulti && (selectedIndices.length > 0 || (isOtherOpen && otherText.trim().length > 0))) ||
    ((isOtherOpen || freeTextOnly) && otherText.trim().length > 0);

  return (
    <div
      role="region"
      aria-label="Agent question"
      data-testid="docked-prompt-card"
      className="rounded-2xl border border-accent/35 bg-surface shadow-xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-3.5 pt-2.5 pb-2 bg-accent/[0.08] border-b border-white/[0.06]">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <MessageSquareMore className="w-4 h-4 text-accent-soft shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-accent-soft">
              {isMulti ? "Select all that apply" : "Question"}
            </div>
            <div className="mt-0.5 text-[13.5px] font-medium text-fg leading-snug">
              <NativeChatProse content={awaiting.prompt} compact />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Minimize question"
            aria-label="Minimize question"
            className="w-7 h-7 rounded-lg hover:bg-white/[0.06] text-muted hover:text-fg flex items-center justify-center transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
          {onCancel && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void onCancel()}
              title="Skip / Cancel"
              aria-label="Cancel question"
              className="w-7 h-7 rounded-lg hover:bg-rose-500/15 text-muted hover:text-rose-300 flex items-center justify-center transition-colors disabled:opacity-50"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Options + Write-in */}
      <div className="p-2.5 space-y-1.5 max-h-[44vh] overflow-y-auto scrollbar-sleek">
        {options.map((opt, idx) => {
          const selected = selectedIndices.includes(idx);
          return (
            <button
              key={`q-opt-${idx}`}
              type="button"
              disabled={submitting}
              onClick={() => handleOptionPress(idx)}
              className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "bg-accent/20 border-accent text-fg"
                  : "bg-raised/70 hover:bg-raised border-white/[0.08] text-fg-soft"
              }`}
            >
              <span
                className={`mt-0.5 text-[11px] font-mono tabular-nums shrink-0 w-4 text-right ${
                  selected ? "text-accent-soft font-semibold" : "text-dim"
                }`}
              >
                {idx + 1}.
              </span>
              <span className="flex-1 min-w-0 text-[13px] leading-snug break-words">
                <NativeChatProse content={opt} compact />
              </span>
              {isMulti ? (
                <span
                  className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
                    selected ? "bg-accent border-accent text-white" : "border-white/20"
                  }`}
                >
                  {selected && <Check className="w-3 h-3 stroke-[3]" />}
                </span>
              ) : (
                selected &&
                submitting && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-soft mt-0.5 shrink-0" />
                )
              )}
            </button>
          );
        })}

        {options.length > 0 && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setIsOtherOpen((prev) => !prev);
              if (!isMulti) setSelectedIndices([]);
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors ${
              isOtherOpen
                ? "bg-accent/15 border-accent/60 text-fg"
                : "bg-transparent hover:bg-white/[0.03] border-white/[0.06] text-muted"
            }`}
          >
            <PenLine className="w-3.5 h-3.5 text-muted shrink-0 ml-0.5" />
            <span className="text-[12.5px] font-medium">Write-in / Other…</span>
          </button>
        )}

        {(isOtherOpen || freeTextOnly) && (
          <div className="pt-1 flex items-end gap-2">
            <textarea
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (otherText.trim()) {
                    void submitPayload(isMulti ? selectedIndices : [], otherText);
                  }
                }
              }}
              placeholder="Type your custom answer…"
              rows={2}
              autoFocus
              className="flex-1 bg-bg border border-accent/40 rounded-xl px-3 py-2 text-[13px] text-fg placeholder-dim focus:outline-none focus:border-accent resize-none font-sans"
            />
            {!isMulti && (
              <button
                type="button"
                disabled={submitting || !otherText.trim()}
                onClick={() => void submitPayload([], otherText)}
                className="h-9 px-3 rounded-xl bg-accent hover:bg-accent-soft text-white font-semibold text-xs flex items-center gap-1.5 shrink-0 disabled:opacity-40 transition-colors"
              >
                {submitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>Send</span>
              </button>
            )}
          </div>
        )}
      </div>

      {isMulti && (
        <div className="px-3 py-2 border-t border-white/[0.06] flex justify-end">
          <button
            type="button"
            disabled={submitting || !canSubmitManual}
            onClick={() => void submitPayload(selectedIndices, isOtherOpen ? otherText : undefined)}
            className="h-8 px-3.5 rounded-xl bg-accent hover:bg-accent-soft text-white font-semibold text-xs flex items-center gap-1.5 disabled:opacity-40 transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            <span>Submit</span>
          </button>
        </div>
      )}
    </div>
  );
}
