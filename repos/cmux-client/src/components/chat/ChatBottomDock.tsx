import { useState, type RefObject } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { ActiveBackgroundWork, ChatTaskList } from "../../domain/chat/taskList";
import type { ComposerDockState } from "../../domain/chat/types";
import type { AgentLifecycleState } from "../../protocol/event";
import { agentDisplayName } from "../common/agentBrand";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { MobileNativeChatComposerTray } from "./MobileNativeChatComposerTray";
import {
  MobileNativeChatPromptCard,
  type QuestionAnswerPayload,
} from "./MobileNativeChatPromptCard";
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
      className={`shrink-0 z-30 px-3 sm:px-6 lg:px-7 ${
        isKeyboardVisible ? "pt-1.5 pb-1.5" : "pt-2 safe-bottom"
      } bg-bg min-w-0 max-w-full`}
    >
      <div className="max-w-3xl lg:max-w-none mx-auto w-full space-y-1.5">
        {dock.kind === "startup-dialog" && (
          <div
            role="group"
            aria-label="Agent startup dialog"
            className="mb-1 rounded-lg border border-line-strong bg-surface overflow-hidden"
          >
            <div className="px-3 pt-2.5 pb-1.5">
              <div className="text-[12.5px] font-semibold text-fg">
                {agentDisplayName(agentKind)} · {dock.dialog.title}
              </div>
              <pre className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-snug text-muted">
                {dock.dialog.description}
              </pre>
            </div>
            <div className="px-3 pb-2.5 pt-1 flex flex-col gap-1">
              {dock.dialog.aimed && dock.dialog.choices.length > 0 ? (
                dock.dialog.choices.map((choice, index) => (
                  <button
                    key={`${index}-${choice.label}`}
                    type="button"
                    disabled={answeringChoice !== null || !onAnswerDialog}
                    onClick={() => void handleDialogChoice(index)}
                    className="w-full min-h-[34px] px-2.5 rounded-md border border-line bg-sidebar hover:bg-raised active:opacity-80 text-left text-[12.5px] text-fg disabled:opacity-50 flex items-center justify-between gap-2 transition-colors"
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
                  className="w-full min-h-[34px] px-2.5 rounded-md border border-line bg-sidebar hover:bg-raised text-[12.5px] text-fg transition-colors"
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
          <div className="rounded-lg bg-surface border border-line-strong px-3 py-2 space-y-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-status-wait shrink-0 mt-1.5" />
              <div className="min-w-0 flex-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-snug text-fg-soft font-mono">
                {dock.awaiting.prompt || "Agent requested approval"}
              </div>
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => void onInterrupt()}
                disabled={isStopping || busyApproving}
                className="h-7 px-2.5 bg-raised hover:bg-status-err/15 hover:text-status-err text-muted font-medium text-[12px] rounded-md transition-colors flex items-center gap-1 disabled:opacity-50"
                title="Deny"
              >
                <X className="w-3 h-3" />
                <span>Deny</span>
              </button>
              <button
                type="button"
                disabled={busyApproving || isStopping}
                onClick={() => void handleApproveClick()}
                className="h-7 px-3 bg-fg hover:bg-accent-strong disabled:opacity-60 text-bg font-medium text-[12px] rounded-md transition-colors flex items-center gap-1"
              >
                {busyApproving ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3 stroke-[2.5]" />
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
          isWorking={effectivelyWorking}
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
