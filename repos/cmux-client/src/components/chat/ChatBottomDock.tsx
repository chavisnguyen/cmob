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
      className={`shrink-0 z-30 px-3 sm:px-5 lg:px-8 xl:px-10 ${
        isKeyboardVisible ? "pt-1.5 pb-1.5" : "pt-2 safe-bottom"
      } bg-bg border-t border-white/[0.06] min-w-0 max-w-full`}
    >
      <div className="max-w-3xl lg:max-w-none mx-auto w-full space-y-1.5">
        {dock.kind === "startup-dialog" && (
          <div
            role="group"
            aria-label="Agent startup dialog"
            className="mb-1.5 rounded-xl border border-white/[0.1] bg-surface overflow-hidden"
          >
            <div className="px-3.5 pt-3 pb-1.5">
              <div className="text-[13px] font-semibold text-fg">
                {agentDisplayName(agentKind)} · {dock.dialog.title}
              </div>
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-muted">
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
                    className="w-full min-h-[38px] px-3 rounded-lg border border-white/[0.08] bg-raised/70 hover:bg-raised active:opacity-80 text-left text-[13px] text-fg disabled:opacity-50 flex items-center justify-between gap-2 transition-colors"
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
                  className="w-full min-h-[38px] px-3 rounded-lg border border-white/[0.08] bg-raised/70 hover:bg-raised text-[13px] text-fg transition-colors"
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
          <div className="rounded-xl bg-surface border border-white/[0.1] px-3.5 py-2.5 space-y-2">
            <div className="flex items-start gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-accent-soft shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-snug text-fg-soft">
                {dock.awaiting.prompt || "Agent requested approval"}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void onInterrupt()}
                disabled={isStopping || busyApproving}
                className="h-8 px-3 bg-white/[0.05] hover:bg-rose-500/15 hover:text-rose-300 text-muted font-medium text-[12.5px] rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50"
                title="Deny"
              >
                <X className="w-3.5 h-3.5" />
                <span>Deny</span>
              </button>
              <button
                type="button"
                disabled={busyApproving || isStopping}
                onClick={() => void handleApproveClick()}
                className="h-8 px-3.5 bg-accent hover:bg-accent-strong disabled:opacity-60 text-white font-semibold text-[12.5px] rounded-lg transition-colors flex items-center gap-1.5"
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
