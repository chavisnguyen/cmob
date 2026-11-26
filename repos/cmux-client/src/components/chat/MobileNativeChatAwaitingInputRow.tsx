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
      className="my-1.5 py-2 px-3 rounded-lg border border-line bg-sidebar/70 space-y-1 min-w-0"
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <MessageSquareMore
          className={`w-3.5 h-3.5 shrink-0 ${pending ? "text-status-wait" : "text-dim"}`}
        />
        <span className={pending ? "text-fg font-medium" : "text-muted font-medium"}>
          {pending ? "Asking a question" : "Asked a question"}
        </span>
        {!pending && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-dim font-medium">
            <Check className="w-3 h-3 text-status-ok" />
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
          <CornerDownRight className="w-3.5 h-3.5 text-dim shrink-0 mt-0.5" />
          <div className="text-[12.5px] text-fg bg-surface border border-line rounded-md px-2.5 py-1 min-w-0 break-words">
            <NativeChatProse content={answerText} compact />
          </div>
        </div>
      )}
    </div>
  );
});
