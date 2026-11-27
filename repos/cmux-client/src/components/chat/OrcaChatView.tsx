import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildChatViewModel } from "../../domain/chat/chatViewModel";
import type { PendingSendItem } from "../../domain/chat/types";
import type {
  AgentLifecycleState,
  AgentTurn,
  BackgroundTaskEntry,
  StartupDialogInfo,
  SubagentEntry,
} from "../../protocol/event";
import type { ConnectionState } from "../../transport/wsClient";
import { ChatBottomDock } from "./ChatBottomDock";
import type { ChatComposerHandle } from "./ChatComposer";
import { ChatTurnRow } from "./ChatTimelineRow";
import { ChatVirtualizedTimeline } from "./ChatVirtualizedTimeline";
import { isSupportedImageFile } from "./imageAttach";
import type { QuestionAnswerPayload } from "./MobileNativeChatPromptCard";
import { deriveConversationTasks } from "../../domain/chat/taskList";
import { latestUsage } from "./usageSummary";
import { useChatScrollController } from "./useChatScrollController";

export { ChatTurnRow };

interface OrcaChatViewProps {
  turns: AgentTurn[];
  pendingSends?: readonly PendingSendItem[];
  withinGrace?: boolean;
  snapshotConfirmed?: boolean;
  isSyncing?: boolean;
  connState?: ConnectionState;
  agentKind: string;
  isLoading?: boolean;
  isWorking?: boolean;
  lifecycleState?: AgentLifecycleState;
  activityText?: string | null;
  awaitingPrompt?: string | null;
  activeSubagents?: readonly SubagentEntry[];
  activeBackgroundTasks?: readonly BackgroundTaskEntry[];
  isApproving?: boolean;
  onFollowingChange?: (following: boolean) => void;
  onSend: (text: string, imagePaths?: string[], imagePreviews?: string[]) => Promise<void>;
  onUploadImage?: (base64: string) => Promise<string>;
  surfaceId?: string;
  onApprove: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  startupDialog?: StartupDialogInfo | null;
  onAnswerDialog?: (choice: number) => Promise<void>;
  onAnswerQuestion?: (payload: QuestionAnswerPayload) => Promise<void>;
  onOpenTerminal?: () => void;
  hasMoreHistory?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  isDesktop?: boolean;
}

export function OrcaChatView({
  turns,
  pendingSends,
  withinGrace = false,
  snapshotConfirmed = true,
  isSyncing = false,
  connState = "connected",
  agentKind,
  isLoading = false,
  isWorking = false,
  lifecycleState = "idle",
  activityText = null,
  awaitingPrompt = null,
  activeSubagents = [],
  activeBackgroundTasks = [],
  isApproving = false,
  onFollowingChange,
  onSend,
  onUploadImage,
  surfaceId,
  onApprove,
  onInterrupt,
  hasMoreHistory = false,
  isLoadingOlder = false,
  onLoadOlder,
  startupDialog = null,
  onAnswerDialog,
  onAnswerQuestion,
  onOpenTerminal,
  isDesktop = false,
}: OrcaChatViewProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isDraggingImage, setIsDraggingImage] = useState(false);

  const composerHandleRef = useRef<ChatComposerHandle>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (!isWorking && !withinGrace) setIsStopping(false);
  }, [isWorking, withinGrace]);

  const handleInterrupt = useCallback(async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      await onInterrupt();
    } catch (err) {
      console.warn("Interrupt failed:", err);
      setIsStopping(false);
    }
  }, [isStopping, onInterrupt]);

  const viewModel = useMemo(
    () =>
      buildChatViewModel({
        turns,
        pendingSends,
        surfaceId,
        isWorking,
        withinGrace,
        lifecycleState,
        activityText,
        awaitingPrompt,
        startupDialog,
        snapshotConfirmed,
        isSubmitting,
        isStopping,
        activeSubagents,
        activeBackgroundTasks,
      }),
    [
      turns,
      pendingSends,
      surfaceId,
      isWorking,
      withinGrace,
      lifecycleState,
      activityText,
      awaitingPrompt,
      startupDialog,
      snapshotConfirmed,
      isSubmitting,
      isStopping,
      activeSubagents,
      activeBackgroundTasks,
    ],
  );

  const conversationTasks = useMemo(
    () =>
      deriveConversationTasks(
        turns,
        viewModel.effectivelyWorking,
        activeSubagents,
        activeBackgroundTasks,
      ),
    [turns, viewModel.effectivelyWorking, activeSubagents, activeBackgroundTasks],
  );
  const usage = useMemo(() => latestUsage(turns), [turns]);
  const hasEarlier = Boolean(hasMoreHistory && onLoadOlder);

  const {
    virtualizer,
    scrollContainerRef,
    contentRef,
    sizerRef,
    bottomAnchorRef,
    scrollMargin,
    isScrolledUp,
    isKeyboardVisible,
    handleScroll,
    handleLoadEarlier,
    handleJumpToTail,
  } = useChatScrollController({
    timeline: viewModel.timeline,
    surfaceId,
    hasEarlier,
    isLoading,
    isLoadingOlder,
    onLoadOlder,
    isWorking: viewModel.effectivelyWorking,
    isSubmitting,
    isDesktop,
    onFollowingChange,
  });

  const handleAnswerQuestionPayload = useCallback(
    async (payload: QuestionAnswerPayload) => {
      setSendError(null);
      try {
        if (onAnswerQuestion) await onAnswerQuestion(payload);
        else await onSend(payload.displayText);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Could not submit your answer.");
      }
    },
    [onAnswerQuestion, onSend],
  );

  const { timeline } = viewModel;
  const virtualItems = timeline.length > 0 ? virtualizer.getVirtualItems() : [];
  const totalVirtualHeight = timeline.length > 0 ? virtualizer.getTotalSize() : 0;

  return (
    <div
      onDragEnter={(e) => {
        if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setIsDraggingImage(true);
      }}
      onDragOver={(e) => {
        if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDraggingImage(false);
      }}
      onDrop={(e) => {
        if (!onUploadImage) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDraggingImage(false);
        const dropped = Array.from(e.dataTransfer.files).filter(isSupportedImageFile);
        if (dropped.length > 0) void composerHandleRef.current?.pickImages(dropped);
      }}
      className={`flex flex-col h-full w-full max-w-full bg-bg text-fg relative overflow-hidden ${
        isDraggingImage ? "ring-2 ring-inset ring-accent/60" : ""
      }`}
    >
      <ChatVirtualizedTimeline
        timeline={timeline}
        virtualItems={virtualItems}
        totalVirtualHeight={totalVirtualHeight}
        scrollMargin={scrollMargin}
        measureElement={virtualizer.measureElement}
        scrollContainerRef={scrollContainerRef}
        contentRef={contentRef}
        sizerRef={sizerRef}
        bottomAnchorRef={bottomAnchorRef}
        agentKind={agentKind}
        surfaceId={surfaceId}
        liveActivity={viewModel.liveActivity}
        hasEarlier={hasEarlier}
        isLoading={isLoading}
        isSyncing={isSyncing}
        connState={connState}
        isLoadingOlder={isLoadingOlder}
        isScrolledUp={isScrolledUp}
        onScroll={handleScroll}
        onLoadEarlier={handleLoadEarlier}
        onJumpToTail={handleJumpToTail}
      />

      <ChatBottomDock
        composerHandleRef={composerHandleRef}
        dock={viewModel.dock}
        agentKind={agentKind}
        surfaceId={surfaceId}
        effectivelyWorking={viewModel.effectivelyWorking}
        lifecycleState={lifecycleState}
        needsAnswer={viewModel.needsAnswer}
        usage={usage}
        isDesktop={isDesktop}
        isKeyboardVisible={isKeyboardVisible}
        isStopping={isStopping}
        isApproving={isApproving}
        sendError={sendError}
        taskList={conversationTasks.dockedTaskList}
        backgroundWork={conversationTasks.backgroundWork}
        onSetSendError={setSendError}
        onSend={onSend}
        onUploadImage={onUploadImage}
        onApprove={onApprove}
        onInterrupt={handleInterrupt}
        onAnswerDialog={onAnswerDialog}
        onAnswerQuestion={handleAnswerQuestionPayload}
        onOpenTerminal={onOpenTerminal}
        onScrollToTail={handleJumpToTail}
        onSubmittingChange={setIsSubmitting}
      />
    </div>
  );
}
