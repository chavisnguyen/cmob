/**
 * Orca-style Inline Question Row & Resolution Receipt
 *
 * Renders inside the transcript where the agent asked a question:
 * - Pending: `MessageSquareMore` + `Asking a question` + question markdown (options live in the docked `PromptCard`).
 * - Resolved: `MessageSquareMore` + `Asked a question` + question markdown + crisp selected answer receipt (`↳ ...`).
 *
 * Sources:
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatAwaitingInputRow.tsx
 * - ref/orca/src/shared/native-chat/native-chat-resolution-receipt.ts
 */

import { memo } from "react";
import { Check, CornerDownRight, MessageSquareMore } from "lucide-react";
import type { AwaitingInput } from "../../protocol/event";
import { NativeChatProse } from "./NativeChatProse";

interface MobileNativeChatAwaitingInputRowProps {
  awaiting: AwaitingInput;
  pending: boolean;
}

export const MobileNativeChatAwaitingInputRow = memo(function MobileNativeChatAwaitingInputRow({
  awaiting,
  pending,
}: MobileNativeChatAwaitingInputRowProps) {
  const answerText = awaiting.answered?.trim() || null;

  return (
    <div
      aria-live={pending ? "polite" : undefined}
      data-testid={pending ? "awaiting-question-row" : "resolved-question-row"}
      className="my-1.5 py-1.5 px-2.5 rounded-xl border border-white/[0.07] bg-surface/60 space-y-1 min-w-0"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <MessageSquareMore
          className={`w-3.5 h-3.5 shrink-0 ${pending ? "text-accent-soft" : "text-muted"}`}
        />
        <span className={pending ? "text-accent-soft font-medium" : "text-muted font-medium"}>
          {pending ? "Asking a question" : "Asked a question"}
        </span>
        {!pending && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-400/90 font-medium">
            <Check className="w-3 h-3" />
            Answered
          </span>
        )}
      </div>

      {awaiting.prompt && (
        <div className="pl-5 text-[13px] text-fg-soft leading-snug min-w-0">
          <NativeChatProse content={awaiting.prompt} compact />
        </div>
      )}

      {!pending && answerText && answerText !== "Answered" && (
        <div className="pl-5 pt-0.5 flex items-start gap-1.5 min-w-0">
          <CornerDownRight className="w-3.5 h-3.5 text-emerald-400/80 shrink-0 mt-0.5" />
          <div className="text-[12.5px] font-medium text-fg bg-raised/80 border border-white/[0.08] rounded-lg px-2.5 py-1 min-w-0 break-words">
            <NativeChatProse content={answerText} compact />
          </div>
        </div>
      )}
    </div>
  );
});
