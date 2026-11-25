/**
 * High-Fidelity Orca-style Native Chat View for AI Coding Agents (Antigravity, Claude, Codex, Kiro)
 * Sources & Architecture:
 * - ref/orca/mobile/src/session/native-chat/MobileNativeChatView.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatReasoningRow.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatToolRun.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatSubagentGroup.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatAwaitingInputRow.tsx
 */

import { memo, useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { useVirtualizer, elementScroll } from "@tanstack/react-virtual";
import { CheckCircle2, Clock, AlertTriangle, ChevronUp, Loader2, X } from "lucide-react";
import type {
  AgentTurn,
  AgentEvent,
  AwaitingInput,
  AgentLifecycleState,
  StartupDialogInfo,
} from "../../protocol/event";
import { NativeChatProse } from "./NativeChatProse";
import { MobileNativeChatReasoningRow } from "./MobileNativeChatReasoningRow";
import { MobileNativeChatToolRun, type ToolCallItem } from "./MobileNativeChatToolRun";
import { MobileNativeChatSubagentGroup } from "./MobileNativeChatSubagentGroup";
import { MobileNativeChatAwaitingInputRow } from "./MobileNativeChatAwaitingInputRow";
import { NativeChatJumpToLatest } from "./NativeChatJumpToLatest";
import { CollapsibleText } from "./CollapsibleText";
import { NativeChatTurnActivityLine } from "./NativeChatTurnActivityLine";
import { AgentIcon } from "../common/AgentIcon";
import { agentDisplayName } from "../common/agentBrand";
import { resolveEffectiveAwaiting } from "./chatQueue";
import { latestUsage } from "./usageSummary";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { TURN_LIST_GAP_PX, createProgrammaticScrollMarks, estimateTurnHeight } from "./chatVirtual";

interface OrcaChatViewProps {
  turns: AgentTurn[];
  agentKind: string;
  /** True until the first readSession response arrives (shows a spinner instead of an empty state). */
  isLoading?: boolean;
  isWorking?: boolean;
  lifecycleState?: AgentLifecycleState;
  activityText?: string | null;
  awaitingPrompt?: string | null;
  /** `imagePaths` are host paths of already uploaded images, pasted before the text. */
  onSend: (text: string, imagePaths?: string[]) => Promise<void>;
  /** Uploads one prepared image; resolves with its path on the host. */
  onUploadImage?: (base64: string) => Promise<string>;
  /** Surface the chat belongs to; enables the model/effort sheet for agents that have options. */
  surfaceId?: string;
  onApprove: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  /** A startup dialog (folder trust, update...) the agent is waiting on. */
  startupDialog?: StartupDialogInfo | null;
  onAnswerDialog?: (choice: number) => Promise<void>;
  onOpenTerminal?: () => void;
  /** Gateway reports older turns beyond what was fetched. */
  hasMoreHistory?: boolean;
  isLoadingOlder?: boolean;
  /** Fetch an older page from the gateway (turns are prepended via `turns`). */
  onLoadOlder?: () => Promise<void>;
  /** Enables desktop composer ergonomics (Enter to send, Shift+Enter newline, drag-drop). */
  isDesktop?: boolean;
}

/**
 * Strips raw internal agent XML envelopes like <USER_REQUEST> and <ADDITIONAL_METADATA>
 * so mobile users see clean, uncluttered user messages.
 */
function cleanUserPrompt(text: string): string {
  let s = text.trim();
  const reqMatch = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) {
    return reqMatch[1].trim();
  }
  const promptMatch = s.match(/<user_prompt>([\s\S]*?)<\/user_prompt>/i);
  if (promptMatch) {
    return promptMatch[1].trim();
  }
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "").trim();
  // Image placeholders the agent CLI inserts: "[Image #3]" and "[Image: source: /path/file.png]".
  return s
    .replace(/\[Image(?: #(\d+))?(?::[^\]]*)?\]/g, (_, n) => (n ? `🖼 Image ${n}` : "🖼 Image"))
    .trim();
}

export function OrcaChatView({
  turns,
  agentKind,
  isLoading = false,
  isWorking = false,
  lifecycleState = "idle",
  activityText = null,
  awaitingPrompt = null,
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
  onOpenTerminal,
  isDesktop = false,
}: OrcaChatViewProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answeringChoice, setAnsweringChoice] = useState<number | null>(null);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [scrollMargin, setScrollMargin] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const composerHandleRef = useRef<ChatComposerHandle>(null);
  const dragDepthRef = useRef(0);
  const isFollowingRef = useRef(true);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const programmaticScrollMarks = useMemo(() => createProgrammaticScrollMarks(), []);

  // Sync isStopping held state back to false when agent transitions out of running
  useEffect(() => {
    if (!isWorking) {
      setIsStopping(false);
    }
  }, [isWorking]);

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

  // Check if there is an active awaiting-input in the latest turn.
  // Solves Zombie Approval Card: Never resurrect old answered questions from historical turns.
  const latestAwaiting = useMemo(() => {
    if (turns.length === 0) return null;
    const lastTurn = turns[turns.length - 1];
    // If the latest turn is from user, agent is either processing or hasn't responded yet
    if (lastTurn.role === "user") return null;

    // Find if there is an awaiting-input event in the latest turn
    const askIndex = lastTurn.events.findIndex((ev) => ev.kind === "awaiting-input");
    if (askIndex === -1) return null;

    // If the agent continued speaking or finished after the awaiting-input in that turn, it's settled
    const subsequentDoneOrText = lastTurn.events
      .slice(askIndex + 1)
      .some((ev) => ev.kind === "done" || (ev.kind === "assistant" && ev.text.trim().length > 0));
    if (subsequentDoneOrText) return null;

    // If lifecycle is known and not waiting, or if isWorking is true, not awaiting input
    if (lifecycleState && lifecycleState !== "waiting") return null;
    if (isWorking) return null;

    return lastTurn.events[askIndex] as AwaitingInput;
  }, [turns, isWorking, lifecycleState]);

  const effectiveAwaiting = useMemo(
    () =>
      resolveEffectiveAwaiting({
        latestAwaiting,
        lifecycleState,
        isWorking,
        startupDialog,
        awaitingPrompt,
      }),
    [latestAwaiting, lifecycleState, isWorking, startupDialog, awaitingPrompt],
  );

  const hasEarlier = Boolean(hasMoreHistory && onLoadOlder);

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const turn = turns[index];
      return turn ? estimateTurnHeight(turn) : 80;
    },
    getItemKey: (index) => turns[index]?.id || `turn-${index}`,
    overscan: 6,
    gap: TURN_LIST_GAP_PX,
    scrollMargin,
    anchorTo: "end",
    followOnAppend: false,
    scrollEndThreshold: -1,
    scrollToFn: (offset, options, instance) => {
      const el = scrollContainerRef.current;
      if (el) programmaticScrollMarks.mark(el);
      elementScroll(offset, options, instance);
    },
  });

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const offset = instance.scrollOffset ?? 0;
    const written = scrollContainerRef.current?.scrollTop ?? offset;
    if (Math.abs(written - offset) > 120) {
      return false;
    }
    return isFollowingRef.current || item.end <= offset + instance.options.scrollMargin;
  };

  const updateScrollMargin = useCallback(() => {
    const scrollEl = scrollContainerRef.current;
    const sizerEl = sizerRef.current;
    if (!scrollEl || !sizerEl) {
      setScrollMargin((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const next = Math.max(
      0,
      Math.round(
        sizerEl.getBoundingClientRect().top -
          scrollEl.getBoundingClientRect().top +
          scrollEl.scrollTop,
      ),
    );
    setScrollMargin((prev) => (prev === next ? prev : next));
  }, []);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [updateScrollMargin, hasEarlier, turns.length]);

  // Scroll to tail helper (direct scrollTop assignment avoids cross-container scrollIntoView side-effects)
  const scrollToTail = useCallback(
    (behavior: ScrollBehavior = "instant") => {
      const container = scrollContainerRef.current;
      if (container) {
        if (behavior !== "smooth" && turnsRef.current.length > 0) {
          programmaticScrollMarks.mark(container);
          virtualizer.scrollToEnd({ behavior: "auto" });
        }
        programmaticScrollMarks.mark(container);
        if (behavior === "smooth") {
          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        } else {
          container.scrollTop = container.scrollHeight;
        }
        return;
      }
      bottomAnchorRef.current?.scrollIntoView({ behavior, block: "end" });
    },
    [programmaticScrollMarks, virtualizer],
  );

  // Immediate bottom pinning on mount and on turn updates
  useLayoutEffect(() => {
    if (!isFollowingRef.current) return;
    scrollToTail("instant");
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      scrollToTail("instant");
      r2 = requestAnimationFrame(() => {
        scrollToTail("instant");
      });
    });
    return () => {
      cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
    };
  }, [turns.length, isWorking, isSubmitting, scrollToTail]);

  // Content & viewport resize observer: keep scrollMargin synced and pinned at tail when following
  useEffect(() => {
    const contentEl = contentRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!contentEl && !scrollEl) return;
    const observer = new ResizeObserver(() => {
      updateScrollMargin();
      if (isFollowingRef.current) {
        scrollToTail("instant");
      }
    });
    if (contentEl) observer.observe(contentEl);
    if (scrollEl) observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollToTail, updateScrollMargin]);

  // Load earlier messages while keeping scroll position stable.
  const pendingAnchorRef = useRef<number | null>(null);
  const handleLoadEarlier = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasEarlier || isLoadingOlder || pendingAnchorRef.current !== null) return;
    pendingAnchorRef.current = container.scrollHeight - container.scrollTop;
    void onLoadOlder!().finally(() => {
      requestAnimationFrame(() => {
        pendingAnchorRef.current = null;
      });
    });
  }, [hasEarlier, isLoadingOlder, onLoadOlder]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = pendingAnchorRef.current;
    if (!container || anchor === null) return;
    if (!isFollowingRef.current) {
      programmaticScrollMarks.mark(container);
      container.scrollTop = Math.max(0, container.scrollHeight - anchor);
    }
    pendingAnchorRef.current = null;
  }, [turns.length, programmaticScrollMarks]);

  // When the content does not fill the viewport there is no scroll event, so keep pulling older
  // pages until it overflows (or history runs out).
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoading || isLoadingOlder || !hasEarlier) return;
    const id = requestAnimationFrame(() => {
      if (container.scrollHeight <= container.clientHeight + 60) handleLoadEarlier();
    });
    return () => cancelAnimationFrame(id);
  }, [turns.length, hasEarlier, isLoading, isLoadingOlder, handleLoadEarlier]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (programmaticScrollMarks.consume(container)) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceToBottom = scrollHeight - (scrollTop + clientHeight);

    const isUp = distanceToBottom > 80;
    isFollowingRef.current = !isUp;
    setIsScrolledUp((prev) => (prev === isUp ? prev : isUp));

    // Auto load earlier if user scrolled near the top
    if (scrollTop < 60 && hasEarlier && !isLoadingOlder) {
      handleLoadEarlier();
    }
  };

  const handleJumpToTail = () => {
    isFollowingRef.current = true;
    setIsScrolledUp(false);
    scrollToTail("smooth");
  };

  // Dynamic Keyboard Visibility Tracking on iOS
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const isDesktopRef = useRef(isDesktop);
  useEffect(() => {
    isDesktopRef.current = isDesktop;
    if (isDesktop) {
      setIsKeyboardVisible(false);
    }
  }, [isDesktop]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;

    const onViewportChange = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      if (isDesktopRef.current) {
        setIsKeyboardVisible(false);
        return;
      }
      const ae = document.activeElement;
      const textFocused = ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement;
      const keyboardOpen = window.innerHeight - vv.height > 100 || textFocused;
      setIsKeyboardVisible((prev) => (prev === keyboardOpen ? prev : keyboardOpen));
      if (keyboardOpen) {
        if (window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
        scrollToTail("instant");
      }
    };

    window.visualViewport.addEventListener("resize", onViewportChange);
    window.visualViewport.addEventListener("scroll", onViewportChange);
    window.addEventListener("focusin", onViewportChange);
    window.addEventListener("focusout", onViewportChange);
    onViewportChange();

    return () => {
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
      window.removeEventListener("focusin", onViewportChange);
      window.removeEventListener("focusout", onViewportChange);
    };
  }, [scrollToTail]);

  const handleAnswer = async (choice: number) => {
    if (!onAnswerDialog || answeringChoice !== null) return;
    setAnsweringChoice(choice);
    setSendError(null);
    try {
      await onAnswerDialog(choice);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not answer the dialog.");
    } finally {
      setAnsweringChoice(null);
    }
  };

  const usage = useMemo(() => latestUsage(turns), [turns]);
  const needsAnswer = !!effectiveAwaiting || !!startupDialog;

  const handleComposerScrollToTail = useCallback(() => {
    isFollowingRef.current = true;
    setIsScrolledUp(false);
    scrollToTail("instant");
  }, [scrollToTail]);

  const handleSubmitAwaiting = useCallback(
    async (resp: string) => {
      await onSend(resp);
    },
    [onSend],
  );

  const virtualItems = turns.length > 0 ? virtualizer.getVirtualItems() : [];
  const totalVirtualHeight = turns.length > 0 ? virtualizer.getTotalSize() : 0;
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const topSpacerHeight = firstVirtualItem ? Math.max(0, firstVirtualItem.start - scrollMargin) : 0;
  const bottomSpacerHeight = lastVirtualItem
    ? Math.max(0, totalVirtualHeight - (lastVirtualItem.end - scrollMargin))
    : 0;

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
        const dropped = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        if (dropped.length > 0) {
          void composerHandleRef.current?.pickImages(dropped);
        }
      }}
      className={`flex flex-col h-full w-full max-w-full bg-bg text-fg relative overflow-hidden ${
        isDraggingImage ? "ring-2 ring-inset ring-accent/60" : ""
      }`}
    >
      {/* Timeline with the agent's logo as a faint watermark behind the messages */}
      <div className="relative flex-1 min-h-0 min-w-0">
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
        >
          <div
            className={`text-white opacity-[0.07] ${isWorking ? "cmux-watermark-breathe" : ""}`}
            data-testid="chat-watermark"
          >
            <AgentIcon kind={agentKind} size={200} className="w-[min(46vw,200px)] h-auto" />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="relative h-full overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-2.5 scrollbar-sleek [overflow-anchor:none] min-w-0 max-w-full select-text"
        >
          <div
            ref={contentRef}
            className="min-h-full flex flex-col justify-end min-w-0 max-w-4xl mx-auto w-full"
          >
            {/* Load Earlier Messages Banner */}
            {hasEarlier && (
              <div className="flex justify-center py-1.5 pb-2 shrink-0">
                <button
                  type="button"
                  onClick={handleLoadEarlier}
                  disabled={isLoadingOlder}
                  className="flex items-center gap-1 px-3 py-1 rounded-full bg-surface hover:bg-raised border border-line text-[11px] text-muted hover:text-fg-soft transition-colors shadow-sm"
                >
                  <ChevronUp className="w-3 h-3 text-muted" />
                  <span>
                    {isLoadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                  </span>
                </button>
              </div>
            )}

            {turns.length === 0 && isLoading ? (
              <div
                role="status"
                aria-live="polite"
                className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-6 text-dim my-auto"
              >
                <Loader2 className="w-6 h-6 animate-spin text-accent-soft mb-2.5" />
                <p className="text-sm font-medium text-fg-soft">Loading conversation…</p>
              </div>
            ) : turns.length === 0 ? (
              <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-6 text-dim my-auto">
                <p className="text-sm font-medium text-fg-soft">
                  Active Session with {agentDisplayName(agentKind)}
                </p>
                <p className="text-xs text-dim mt-1 max-w-xs">
                  Direct bidirectional chat control connected to cmux host.
                </p>
              </div>
            ) : (
              <div ref={sizerRef} className="w-full min-w-0">
                {topSpacerHeight > 0 && (
                  <div
                    aria-hidden="true"
                    style={{ height: topSpacerHeight, overflowAnchor: "none" }}
                  />
                )}
                {(() => {
                  let previousEnd = firstVirtualItem ? firstVirtualItem.start : scrollMargin;
                  return virtualItems.map((virtualItem) => {
                    const turn = turns[virtualItem.index];
                    if (!turn) return null;
                    const gapHeight = Math.max(0, virtualItem.start - previousEnd);
                    previousEnd = virtualItem.end;
                    const isLastTurn = virtualItem.index === turns.length - 1;
                    return (
                      <div key={virtualItem.key} className="w-full min-w-0">
                        {gapHeight > 0 && (
                          <div
                            aria-hidden="true"
                            style={{ height: gapHeight, overflowAnchor: "none" }}
                          />
                        )}
                        <div
                          data-index={virtualItem.index}
                          ref={virtualizer.measureElement}
                          className="flow-root w-full min-w-0"
                        >
                          <ChatTurnRow
                            turn={turn}
                            isLastTurn={isLastTurn}
                            isWorking={isLastTurn && isWorking}
                            activeAwaiting={isLastTurn ? latestAwaiting : null}
                            onSubmitAwaiting={handleSubmitAwaiting}
                          />
                        </div>
                      </div>
                    );
                  });
                })()}
                {bottomSpacerHeight > 0 && (
                  <div
                    aria-hidden="true"
                    style={{ height: bottomSpacerHeight, overflowAnchor: "none" }}
                  />
                )}
              </div>
            )}

            {/* Orca Live Activity Line (Instant feedback while agent is thinking/working) */}
            {(isWorking || isSubmitting) && (
              <div className="w-full flex justify-start pt-2 my-0.5 pl-1 min-w-0 max-w-full">
                <NativeChatTurnActivityLine activityText={activityText} />
              </div>
            )}

            {/* Tail Anchor */}
            <div ref={bottomAnchorRef} className="h-px w-full" />
          </div>
        </div>
        <NativeChatJumpToLatest visible={isScrolledUp} onJump={handleJumpToTail} />
      </div>

      {/* Sticky Bottom Actions & Prompt Composer */}
      <div
        className={`shrink-0 z-30 px-3 ${
          isKeyboardVisible ? "pt-1.5 pb-1.5" : "pt-2 safe-bottom"
        } bg-bg border-t border-white/[0.08] min-w-0 max-w-full`}
      >
        <div className="max-w-4xl mx-auto w-full space-y-1.5">
          {/* Orca-style Contextual Approval Card */}
          {effectiveAwaiting &&
            (!effectiveAwaiting.options || effectiveAwaiting.options.length === 0) && (
              <div className="rounded-xl bg-emerald-950/30 border border-emerald-500/25 px-3 py-2.5 space-y-2">
                <div className="flex items-start gap-2 min-w-0">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-snug text-emerald-100">
                    {effectiveAwaiting.prompt || "Agent requested approval"}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleInterrupt}
                    disabled={isStopping}
                    className="h-9 px-3.5 bg-raised hover:bg-rose-950/50 hover:text-rose-300 text-fg-soft font-medium text-[13px] rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    title="Deny"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Deny</span>
                  </button>
                  <button
                    type="button"
                    onClick={onApprove}
                    className="h-9 px-3.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold text-[13px] rounded-xl transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Approve</span>
                  </button>
                </div>
              </div>
            )}

          {startupDialog && (
            <div
              role="group"
              aria-label="Agent startup dialog"
              className="mb-1.5 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] overflow-hidden"
            >
              <div className="px-3.5 pt-3 pb-1.5">
                <div className="text-[13px] font-semibold text-amber-200">
                  {agentDisplayName(agentKind)} is asking: {startupDialog.title}
                </div>
                <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-fg-soft">
                  {startupDialog.description}
                </pre>
              </div>
              <div className="px-3.5 pb-3 pt-1 flex flex-col gap-1.5">
                {startupDialog.aimed && startupDialog.choices.length > 0 ? (
                  startupDialog.choices.map((choice, index) => (
                    <button
                      key={`${index}-${choice.label}`}
                      type="button"
                      disabled={answeringChoice !== null || !onAnswerDialog}
                      onClick={() => void handleAnswer(index)}
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

          <ChatComposer
            ref={composerHandleRef}
            agentKind={agentKind}
            surfaceId={surfaceId}
            isWorking={isWorking}
            lifecycleState={lifecycleState}
            needsAnswer={needsAnswer}
            usage={usage}
            isDesktop={isDesktop}
            isStopping={isStopping}
            sendError={sendError}
            onSetSendError={setSendError}
            onSend={onSend}
            onUploadImage={onUploadImage}
            onInterrupt={handleInterrupt}
            onOpenTerminal={onOpenTerminal}
            onScrollToTail={handleComposerScrollToTail}
            onSubmittingChange={setIsSubmitting}
          />
        </div>
      </div>
    </div>
  );
}

const ChatTurnRow = memo(function ChatTurnRow({
  turn,
  isLastTurn,
  isWorking,
  activeAwaiting,
  onSubmitAwaiting,
}: {
  turn: AgentTurn;
  isLastTurn: boolean;
  isWorking: boolean;
  activeAwaiting: AwaitingInput | null;
  onSubmitAwaiting: (text: string) => Promise<void>;
}) {
  const isUser = turn.role === "user";

  return (
    <div
      className={`flex flex-col ${isUser ? "items-end" : "items-start"} w-full min-w-0 max-w-full`}
    >
      {isUser ? (
        <div className="max-w-[88%] bg-raised border border-white/10 text-fg rounded-2xl rounded-tr-sm px-3.5 py-2 text-[13px] leading-relaxed shadow-sm min-w-0 break-words [overflow-wrap:anywhere]">
          {turn.events.map((ev, eIdx) =>
            ev.kind === "user" ? (
              <CollapsibleText
                key={`u-${eIdx}`}
                text={cleanUserPrompt(ev.text)}
                className="whitespace-pre-wrap font-sans min-w-0 break-words [overflow-wrap:anywhere]"
              />
            ) : null,
          )}
        </div>
      ) : (
        <div className="w-full max-w-full min-w-0 space-y-1.5">
          {renderAssistantTurnEvents(
            turn.events,
            isLastTurn,
            isWorking,
            activeAwaiting,
            onSubmitAwaiting,
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Group sequential events in an assistant turn into Orca-style components:
 * - Collapsible Thinking accordions
 * - Grouped Tool runs
 * - Subagent cards
 * - Awaiting input cards
 * - Rich markdown prose
 */
function renderAssistantTurnEvents(
  events: AgentEvent[],
  isLastTurn: boolean,
  isWorking: boolean,
  latestAwaiting: AwaitingInput | null,
  onSubmitAwaiting: (text: string) => Promise<void>,
) {
  const renderedElements: React.ReactNode[] = [];
  let pendingTools: ToolCallItem[] = [];

  const flushTools = (keyPrefix: string) => {
    if (pendingTools.length > 0) {
      const toolItems = [...pendingTools];
      pendingTools = [];
      renderedElements.push(
        <MobileNativeChatToolRun
          key={`tr-${keyPrefix}-${toolItems[0].id}`}
          tools={toolItems}
          live={isWorking && isLastTurn && toolItems.some((t) => !t.isEnd)}
        />,
      );
    }
  };

  events.forEach((ev, idx) => {
    if (ev.kind === "tool-start") {
      pendingTools.push({
        id: ev.tool_id,
        name: ev.name,
        detail: ev.detail,
        isEnd: false,
      });
      return;
    }

    if (ev.kind === "tool-end") {
      const existing = pendingTools.find((t) => t.id === ev.tool_id);
      if (existing) {
        existing.isEnd = true;
        existing.ok = ev.ok;
        if (ev.detail) existing.detail = ev.detail;
      } else {
        pendingTools.push({
          id: ev.tool_id,
          name: ev.name || "tool",
          detail: ev.detail,
          ok: ev.ok,
          isEnd: true,
        });
      }
      return;
    }

    if (ev.kind === "usage") {
      return;
    }
    if (ev.kind === "thinking" && (!ev.text || !ev.text.trim())) {
      return;
    }
    if ((ev.kind === "assistant" || ev.kind === "delta") && (!ev.text || !ev.text.trim())) {
      return;
    }

    flushTools(`idx-${idx}`);

    if (ev.kind === "thinking") {
      renderedElements.push(
        <MobileNativeChatReasoningRow
          key={`th-${idx}`}
          id={`reasoning-${idx}`}
          text={ev.text}
          live={isWorking && isLastTurn && idx === events.length - 1}
        />,
      );
      return;
    }

    if (ev.kind === "subagents") {
      renderedElements.push(
        <MobileNativeChatSubagentGroup
          key={`sub-${idx}`}
          groupId={ev.group_id}
          agents={ev.agents}
        />,
      );
      return;
    }

    if (ev.kind === "awaiting-input") {
      const isActive = isLastTurn && latestAwaiting === ev;
      if (!isActive) {
        renderedElements.push(
          <div
            key={`ask-${idx}`}
            className="p-2.5 my-1.5 rounded-xl bg-surface border border-line text-xs text-muted flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate font-medium text-fg-soft">
                {ev.prompt || "User input requested"}
              </span>
            </div>
            <span className="text-[10px] text-emerald-400/80 uppercase tracking-wider font-semibold shrink-0">
              Answered
            </span>
          </div>,
        );
        return;
      }

      renderedElements.push(
        <MobileNativeChatAwaitingInputRow
          key={`ask-${idx}`}
          awaiting={ev}
          onSubmit={onSubmitAwaiting}
        />,
      );
      return;
    }

    if (ev.kind === "assistant" || ev.kind === "delta") {
      renderedElements.push(
        <div key={`ast-${idx}`} className="py-1">
          <NativeChatProse content={ev.text} />
        </div>,
      );
      return;
    }

    if (ev.kind === "status") {
      renderedElements.push(
        <div key={`st-${idx}`} className="flex items-center gap-1.5 text-xs text-muted py-0.5">
          <Clock className="w-3.5 h-3.5 text-accent-soft" />
          <span>{ev.text}</span>
        </div>,
      );
      return;
    }

    if (ev.kind === "error") {
      renderedElements.push(
        <div
          key={`err-${idx}`}
          className="p-3 rounded-xl bg-rose-950/30 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{ev.message}</span>
        </div>,
      );
      return;
    }
  });

  flushTools("final");

  return renderedElements;
}
