import { useState, type RefObject } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import type { ComposerDockState } from "../../domain/chat/types";
import type { AgentLifecycleState } from "../../protocol/event";
import { agentDisplayName } from "../common/agentBrand";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { MobileNativeChatComposerTray } from "./MobileNativeChatComposerTray";
import {
  MobileNativeChatPromptCard,
  type QuestionAnswerPayload,
} from "./MobileNativeChatPromptCard";
import type { ActiveBackgroundWork, ChatTaskList } from "./taskList";
import type { UsageEvent } from "./usageSummary";

export function ChatBottomDock({
  composerHandleRef,
  dock,
  agentKind,
  surfaceId,
  effectivelyWorking,
  lifecycleState,
  needsAnswer,
  usage,
  isDesktop,
  isKeyboardVisible,
  isStopping,
  isApproving,
  sendError,
  taskList,
  backgroundWork,
  onSetSendError,
  onSend,
  onUploadImage,
  onApprove,
  onInterrupt,
  onAnswerDialog,
  onAnswerQuestion,
  onOpenTerminal,
  onScrollToTail,
  onSubmittingChange,
}: {
  composerHandleRef: RefObject<ChatComposerHandle | null>;
  dock: ComposerDockState;
  agentKind: string;
  surfaceId?: string;
  effectivelyWorking: boolean;
  lifecycleState: AgentLifecycleState;
  needsAnswer: boolean;
  usage: UsageEvent | null;
  isDesktop: boolean;
  isKeyboardVisible: boolean;
  isStopping: boolean;
  isApproving: boolean;
  sendError: string | null;
  taskList: ChatTaskList | null;
  backgroundWork: ActiveBackgroundWork | null;
  onSetSendError: (msg: string | null) => void;
  onSend: (text: string, imagePaths?: string[], imagePreviews?: string[]) => Promise<void>;
  onUploadImage?: (base64: string) => Promise<string>;
  onApprove: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  onAnswerDialog?: (choice: number) => Promise<void>;
  onAnswerQuestion: (payload: QuestionAnswerPayload) => Promise<void>;
  onOpenTerminal?: () => void;
  onScrollToTail: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const [answeringChoice, setAnsweringChoice] = useState<number | null>(null);
  const [localApproving, setLocalApproving] = useState(false);

  const busyApproving = isApproving || localApproving;

  const handleDialogChoice = async (choice: number) => {
    if (!onAnswerDialog || answeringChoice !== null) return;
    setAnsweringChoice(choice);
    onSetSendError(null);
    try {
      await onAnswerDialog(choice);
    } catch (err) {
      onSetSendError(err instanceof Error ? err.message : "Could not answer the dialog.");
    } finally {
      setAnsweringChoice(null);
    }
  };

  const handleApproveClick = async () => {
    if (busyApproving || isStopping) return;
    setLocalApproving(true);
    try {
      await onApprove();
    } finally {
      setLocalApproving(false);
    }
  };

  return (
    <div
      className={`shrink-0 z-30 px-3 ${
        isKeyboardVisible ? "pt-1.5 pb-1.5" : "pt-2 safe-bottom"
      } bg-bg border-t border-white/[0.08] min-w-0 max-w-full`}
    >
      <div className="max-w-4xl mx-auto w-full space-y-1.5">
        {dock.kind === "startup-dialog" && (
          <div
            role="group"
            aria-label="Agent startup dialog"
            className="mb-1.5 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] overflow-hidden"
          >
            <div className="px-3.5 pt-3 pb-1.5">
              <div className="text-[13px] font-semibold text-amber-200">
                {agentDisplayName(agentKind)} is asking: {dock.dialog.title}
              </div>
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-fg-soft">
                {dock.dialog.description}
              </pre>
            </div>
            <div className="px-3.5 pb-3 pt-1 flex flex-col gap-1.5">
              {dock.dialog.aimed && dock.dialog.choices.length > 0 ? (
                dock.dialog.choices.map((choice, index) => (
                  <button
                    key={`${index}-${choice.label}`}
                    type="button"
                    disabled={answeringChoice !== null || !onAnswerDialog}
                    onClick={() => void handleDialogChoice(index)}
                    className="w-full min-h-[40px] px-3 rounded-xl border border-white/[0.12] bg-raised hover:bg-line active:opacity-80 text-left text-[13.5px] text-fg disabled:opacity-50 flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{choice.label}</span>
                    {answeringChoice === index && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    )}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={onOpenTerminal}
                  className="w-full min-h-[40px] px-3 rounded-xl border border-white/[0.12] bg-raised hover:bg-line text-[13.5px] text-fg"
                >
                  Answer in the Terminal tab
                </button>
              )}
            </div>
          </div>
        )}

        {dock.kind === "question" && (
          <MobileNativeChatPromptCard
            key={dock.promptInstanceKey}
            awaiting={dock.awaiting}
            isDesktop={isDesktop}
            onAnswer={onAnswerQuestion}
            onCancel={onInterrupt}
          />
        )}

        {dock.kind === "permission" && (
          <div className="rounded-xl bg-emerald-950/30 border border-emerald-500/25 px-3 py-2.5 space-y-2">
            <div className="flex items-start gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-snug text-emerald-100">
                {dock.awaiting.prompt || "Agent requested approval"}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void onInterrupt()}
                disabled={isStopping || busyApproving}
                className="h-9 px-3.5 bg-raised hover:bg-rose-950/50 hover:text-rose-300 text-fg-soft font-medium text-[13px] rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
                title="Deny"
              >
                <X className="w-3.5 h-3.5" />
                <span>Deny</span>
              </button>
              <button
                type="button"
                disabled={busyApproving || isStopping}
                onClick={() => void handleApproveClick()}
                className="h-9 px-3.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-60 text-white font-semibold text-[13px] rounded-xl transition-colors shadow-sm flex items-center gap-1.5"
              >
                {busyApproving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>{busyApproving ? "Approving…" : "Approve"}</span>
              </button>
            </div>
          </div>
        )}

        <MobileNativeChatComposerTray
          taskList={taskList}
          backgroundWork={backgroundWork}
          scopeKey={surfaceId ?? "default"}
        />

        <ChatComposer
          ref={composerHandleRef}
          agentKind={agentKind}
          surfaceId={surfaceId}
          isWorking={effectivelyWorking}
          lifecycleState={dock.kind !== "none" ? "waiting" : lifecycleState}
          needsAnswer={needsAnswer}
          usage={usage}
          isDesktop={isDesktop}
          isStopping={isStopping}
          sendError={sendError}
          onSetSendError={onSetSendError}
          onSend={onSend}
          onUploadImage={onUploadImage}
          onInterrupt={onInterrupt}
          onOpenTerminal={onOpenTerminal}
          onScrollToTail={onScrollToTail}
          onSubmittingChange={onSubmittingChange}
        />
      </div>
    </div>
  );
}
