/**
 * High-Fidelity Orca-style Native Chat View for AI Coding Agents (Antigravity, Claude, Codex, Kiro)
 * Sources & Architecture:
 * - ref/orca/mobile/src/session/native-chat/MobileNativeChatView.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatReasoningRow.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatToolRun.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatSubagentGroup.tsx
 * - ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatAwaitingInputRow.tsx
 */

import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import {
  Send,
  Square,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronUp,
  Loader2,
  ImagePlus,
  SlidersHorizontal,
  Mic,
  MicOff,
  X,
} from "lucide-react";
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
import { DRAIN_SETTLE_MS, canDrain, enqueue, removeQueued, type QueuedMessage } from "./chatQueue";
import { suggestSlashCommands } from "./slashCommands";
import { appendDictation, canDictate, useDictation } from "./dictation";
import { MAX_IMAGES_PER_MESSAGE, PartialSendError, prepareImageForUpload } from "./imageAttach";
import { contextTokens, formatTokens, latestUsage } from "./usageSummary";
import { hasAgentOptions } from "./agentOptions";
import { AgentOptionsSheet } from "./AgentOptionsSheet";

interface OrcaChatViewProps {
  turns: AgentTurn[];
  agentKind: string;
  /** True until the first readSession response arrives (shows a spinner instead of an empty state). */
  isLoading?: boolean;
  isWorking?: boolean;
  lifecycleState?: AgentLifecycleState;
  activityText?: string | null;
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
  return s;
}

const WINDOW_CHUNK_SIZE = 30;

export function OrcaChatView({
  turns,
  agentKind,
  isLoading = false,
  isWorking = false,
  lifecycleState = "idle",
  activityText = null,
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
}: OrcaChatViewProps) {
  const [inputText, setInputText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [visibleCount, setVisibleCount] = useState(WINDOW_CHUNK_SIZE);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const isFollowingRef = useRef(true);

  // Sync isStopping held state back to false when agent transitions out of running
  useEffect(() => {
    if (!isWorking) {
      setIsStopping(false);
    }
  }, [isWorking]);

  const handleInterrupt = async () => {
    if (isStopping) return;
    setIsStopping(true);
    try {
      await onInterrupt();
    } catch (err) {
      console.warn("Interrupt failed:", err);
      setIsStopping(false);
    }
  };

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

  // Windowed visible turns for pagination & performance
  const hasHiddenLocal = turns.length > visibleCount;
  const hasEarlier = hasHiddenLocal || (hasMoreHistory && !!onLoadOlder);
  const visibleTurns = useMemo(() => {
    if (!hasHiddenLocal) return turns;
    return turns.slice(turns.length - visibleCount);
  }, [turns, visibleCount, hasHiddenLocal]);

  // Scroll to tail helper
  const scrollToTail = useCallback((behavior: ScrollBehavior = "instant") => {
    if (bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView({ behavior, block: "end" });
    } else if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, []);

  // Immediate bottom pinning on mount and on turn updates
  useLayoutEffect(() => {
    if (isFollowingRef.current) {
      scrollToTail("instant");
      const r1 = requestAnimationFrame(() => {
        scrollToTail("instant");
        const r2 = requestAnimationFrame(() => {
          scrollToTail("instant");
        });
        return () => cancelAnimationFrame(r2);
      });
      return () => cancelAnimationFrame(r1);
    }
  }, [visibleTurns.length, isWorking, isSubmitting, scrollToTail]);

  // Content resize observer: keep anchored at the bottom when fonts/markdown/diffs expand
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (isFollowingRef.current) {
        scrollToTail("instant");
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollToTail]);

  // Load earlier messages while keeping scroll position stable.
  // Local window first (already fetched), then ask the gateway for an older page.
  // The anchor (distance from bottom) is restored in a layout effect once the new turns render.
  const pendingAnchorRef = useRef<number | null>(null);
  const handleLoadEarlier = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasEarlier || isLoadingOlder || pendingAnchorRef.current !== null) return;
    pendingAnchorRef.current = container.scrollHeight - container.scrollTop;
    if (hasHiddenLocal) {
      setVisibleCount((prev) => Math.min(turns.length, prev + WINDOW_CHUNK_SIZE));
    } else if (onLoadOlder) {
      // Make the window large enough to show every fetched turn once they arrive.
      setVisibleCount((prev) => Math.max(prev, turns.length + WINDOW_CHUNK_SIZE));
      void onLoadOlder().finally(() => {
        // If nothing new arrived, release the anchor so later loads are not blocked.
        requestAnimationFrame(() => {
          pendingAnchorRef.current = null;
        });
      });
    }
  }, [hasEarlier, hasHiddenLocal, isLoadingOlder, onLoadOlder, turns.length]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = pendingAnchorRef.current;
    if (!container || anchor === null) return;
    if (!isFollowingRef.current) {
      container.scrollTop = container.scrollHeight - anchor;
    }
    pendingAnchorRef.current = null;
  }, [visibleTurns.length]);

  // When the content does not fill the viewport there is no scroll event, so keep pulling older
  // pages until it overflows (or history runs out).
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoading || isLoadingOlder || !hasEarlier) return;
    const id = requestAnimationFrame(() => {
      if (container.scrollHeight <= container.clientHeight + 60) handleLoadEarlier();
    });
    return () => cancelAnimationFrame(id);
  }, [visibleTurns.length, hasEarlier, isLoading, isLoadingOlder, handleLoadEarlier]);

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const distanceToBottom = scrollHeight - (scrollTop + clientHeight);

    const isUp = distanceToBottom > 80;
    isFollowingRef.current = !isUp;
    setIsScrolledUp(isUp);

    // Auto load earlier if user scrolled near the top
    if (scrollTop < 60 && hasEarlier) {
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

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;

    const onViewportChange = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      // When virtual keyboard opens on mobile, visualViewport.height shrinks significantly
      // Some iOS modes (Home Screen app) also shrink innerHeight, so the height delta can read ~0;
      // a focused text field is the fallback signal that the on-screen keyboard is up.
      const ae = document.activeElement;
      const textFocused = ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement;
      const keyboardOpen = window.innerHeight - vv.height > 100 || textFocused;
      setIsKeyboardVisible(keyboardOpen);
      if (keyboardOpen) {
        if (window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
        bottomAnchorRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
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
  }, []);

  const handleInputFocus = () => {
    // Prevent iOS WebKit from scrolling the entire page / layout viewport upwards
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
      });
    }
  };

  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Why the last send was refused (e.g. the agent is showing a startup dialog); cleared on typing.
  const [sendError, setSendError] = useState<string | null>(null);
  const [answeringChoice, setAnsweringChoice] = useState<number | null>(null);

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
  // Auto-grow the composer up to ~6 lines.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [inputText]);

  // Messages typed while the agent is busy wait here and go out one at a time once it is idle.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const queueRef = useRef(queue);
  const drainingRef = useRef(false);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  /** Delivers one message. Returns false (and shows the error) when the gateway refused it. */
  /** How many of the last send's images were already pasted into the agent when it failed. */
  const deliveredRef = useRef(0);

  const sendNow = async (text: string, imagePaths: string[] = []): Promise<boolean> => {
    deliveredRef.current = 0;
    setSendError(null);
    setIsSubmitting(true);
    isFollowingRef.current = true;
    try {
      await onSend(text, imagePaths);
      setIsScrolledUp(false);
      scrollToTail("instant");
      return true;
    } catch (err) {
      console.warn("Send failed:", err);
      if (err instanceof PartialSendError) deliveredRef.current = err.delivered;
      setSendError(err instanceof Error ? err.message : "Could not send the message.");
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  // Images picked for the next message, already uploaded to the host (path) with a local preview.
  const [images, setImages] = useState<Array<{ id: string; path: string; previewUrl: string }>>([]);
  const [uploading, setUploading] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePickImages = async (files: FileList | null) => {
    if (!files || !onUploadImage) return;
    const room = MAX_IMAGES_PER_MESSAGE - images.length - uploading;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > picked.length)
      setSendError(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images.`);
    for (const file of picked) {
      setUploading((n) => n + 1);
      try {
        const prepared = await prepareImageForUpload(file);
        const path = await onUploadImage(prepared.base64);
        setImages((cur) => [
          ...cur,
          { id: `img-${Date.now()}-${cur.length}`, path, previewUrl: prepared.previewUrl },
        ]);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Could not upload the image.");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  // Free the preview blobs of images still attached when the composer goes away.
  useEffect(
    () => () => {
      imagesRef.current.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    },
    [],
  );

  const removeImage = (id: string) =>
    setImages((cur) => {
      const gone = cur.find((i) => i.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return cur.filter((i) => i.id !== id);
    });

  const handleSendPrompt = async () => {
    const hasContent = inputText.trim().length > 0 || images.length > 0;
    if (!hasContent || isSubmitting || uploading > 0) return;
    const text = inputText.trim();
    const sent = images;
    const paths = sent.map((i) => i.path);
    setInputText("");
    setImages([]);
    // Queue instead of sending while the agent is busy or waiting on an approval/question: a line typed
    // into a permission prompt would answer it by accident.
    if (isWorking || lifecycleState === "waiting" || !!latestAwaiting || !!startupDialog) {
      setQueue((q) =>
        enqueue(q, text, `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, paths),
      );
      sent.forEach((i) => URL.revokeObjectURL(i.previewUrl)); // the queue keeps only the host paths
      return;
    }
    if (await sendNow(text, paths)) {
      sent.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      return;
    }
    // Delivery failed: give the message back instead of losing it, merging with anything typed meanwhile.
    // Images already pasted into the agent are not restored (a retry would paste them twice).
    const remaining = sent.slice(deliveredRef.current);
    setInputText((current) => (current && current !== text ? `${text}\n${current}` : text));
    setImages((cur) => [...remaining, ...cur].slice(0, MAX_IMAGES_PER_MESSAGE));
  };

  const needsAnswer = !!latestAwaiting || !!startupDialog;
  useEffect(() => {
    if (queuePaused) return;
    if (
      !canDrain({
        queueLength: queue.length,
        isWorking,
        isSubmitting,
        lifecycle: lifecycleState,
        needsAnswer,
      })
    ) {
      return;
    }
    const timer = setTimeout(async () => {
      const head = queueRef.current[0];
      if (!head || drainingRef.current) return;
      drainingRef.current = true;
      setQueue((q) => removeQueued(q, head.id));
      const ok = await sendNow(head.text, head.images);
      if (!ok) {
        // Put it back (minus images already pasted) and stop: retrying automatically would loop on a
        // persistent error.
        setQueue((q) => [{ ...head, images: head.images.slice(deliveredRef.current) }, ...q]);
        setQueuePaused(true);
      }
      drainingRef.current = false;
    }, DRAIN_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queuePaused, isWorking, isSubmitting, lifecycleState, needsAnswer]);

  const usage = useMemo(() => latestUsage(turns), [turns]);
  const [showOptions, setShowOptions] = useState(false);
  const canSetOptions = !!surfaceId && hasAgentOptions(agentKind);

  const dictation = useDictation(
    useCallback((fragment: string) => setInputText((cur) => appendDictation(cur, fragment)), []),
  );

  const slashSuggestions = useMemo(
    () => suggestSlashCommands(agentKind, inputText),
    [agentKind, inputText],
  );

  return (
    <div className="flex flex-col h-full w-full max-w-full bg-[#12131a] text-[#f3f4f6] relative overflow-hidden">
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
          className="relative h-full overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-2.5 space-y-2 scrollbar-sleek [overflow-anchor:none] min-w-0 max-w-full"
        >
          <div
            ref={contentRef}
            className="space-y-2 min-h-full flex flex-col justify-end min-w-0 max-w-full"
          >
            {/* Load Earlier Messages Banner */}
            {hasEarlier && (
              <div className="flex justify-center py-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleLoadEarlier}
                  disabled={isLoadingOlder}
                  className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#1b1c26] hover:bg-[#262837] border border-[#2d3042] text-[11px] text-gray-400 hover:text-gray-200 transition-colors shadow-sm"
                >
                  <ChevronUp className="w-3 h-3 text-gray-400" />
                  <span>
                    {isLoadingOlder
                      ? "Loading earlier messages…"
                      : hasHiddenLocal
                        ? `Load earlier messages (${turns.length - visibleCount} more)`
                        : "Load earlier messages"}
                  </span>
                </button>
              </div>
            )}

            {turns.length === 0 && isLoading ? (
              <div
                role="status"
                aria-live="polite"
                className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-6 text-gray-500 my-auto"
              >
                <Loader2 className="w-6 h-6 animate-spin text-indigo-400 mb-2.5" />
                <p className="text-sm font-medium text-gray-300">Loading conversation…</p>
              </div>
            ) : turns.length === 0 ? (
              <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-6 text-gray-500 my-auto">
                <p className="text-sm font-medium text-gray-300">
                  Active Session with {agentDisplayName(agentKind)}
                </p>
                <p className="text-xs text-gray-500 mt-1 max-w-xs">
                  Direct bidirectional chat control connected to cmux host.
                </p>
              </div>
            ) : (
              visibleTurns.map((turn, tIdx) => {
                const isUser = turn.role === "user";
                const isLastTurn = tIdx === visibleTurns.length - 1;

                return (
                  <div
                    key={turn.id || `turn-${tIdx}`}
                    className={`flex flex-col ${isUser ? "items-end" : "items-start"} w-full min-w-0 max-w-full my-0.5`}
                  >
                    {isUser ? (
                      /* User Prompt Bubble matching Orca dark capsule */
                      <div className="max-w-[88%] bg-[#262626] border border-white/10 text-gray-100 rounded-2xl rounded-tr-sm px-3.5 py-2 text-[13px] leading-relaxed shadow-sm min-w-0 break-words [overflow-wrap:anywhere]">
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
                      /* Assistant Turn Container */
                      <div className="w-full max-w-full min-w-0 space-y-1.5">
                        {renderAssistantTurnEvents(turn.events, isLastTurn, latestAwaiting, onSend)}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* Orca Live Activity Line (Instant feedback while agent is thinking/working) */}
            {(isWorking || isSubmitting) && (
              <div className="w-full flex justify-start my-0.5 pl-1 min-w-0 max-w-full">
                <NativeChatTurnActivityLine activityText={activityText} />
              </div>
            )}

            {/* Tail Anchor */}
            <div ref={bottomAnchorRef} className="h-px w-full" />
          </div>
        </div>
      </div>

      {/* Orca Floating Jump to Latest Pill */}
      <NativeChatJumpToLatest visible={isScrolledUp} onJump={handleJumpToTail} />

      {/* Sticky Bottom Actions & Prompt Composer */}
      <div
        className={`shrink-0 z-30 px-3 ${
          isKeyboardVisible ? "pt-1.5 pb-1.5" : "pt-2 safe-bottom"
        } bg-[#141416] border-t border-white/[0.08] space-y-1.5 min-w-0 max-w-full`}
      >
        {/* Orca-style Contextual Approval Card */}
        {latestAwaiting && (!latestAwaiting.options || latestAwaiting.options.length === 0) && (
          <div className="flex items-center justify-between p-2 rounded-lg bg-emerald-950/30 border border-emerald-500/20 gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="text-xs text-emerald-200 font-medium truncate">
                {latestAwaiting.prompt || "Agent requested approval"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onApprove}
                className="h-9 px-3.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold text-[13px] rounded-xl transition-colors shadow-sm flex items-center gap-1"
              >
                <CheckCircle2 className="w-3 h-3" />
                <span>Approve (1-Tap)</span>
              </button>
              <button
                type="button"
                onClick={handleInterrupt}
                disabled={isStopping}
                className="w-9 h-9 bg-[#262626] hover:bg-rose-950/40 hover:text-rose-400 text-[#e5e5e5] flex items-center justify-center rounded-xl transition-colors"
                title="Deny / Interrupt"
              >
                <X className="w-3 h-3" />
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
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-gray-300">
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
                    className="w-full min-h-[40px] px-3 rounded-xl border border-white/[0.12] bg-[#24242a] hover:bg-[#2e2e36] active:opacity-80 text-left text-[13.5px] text-[#fafafa] disabled:opacity-50 flex items-center justify-between gap-2"
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
                  className="w-full min-h-[40px] px-3 rounded-xl border border-white/[0.12] bg-[#24242a] hover:bg-[#2e2e36] text-[13.5px] text-[#fafafa]"
                >
                  Answer in the Terminal tab
                </button>
              )}
            </div>
          </div>
        )}

        {queue.length > 0 && (
          <div className="mb-1.5 space-y-1" aria-label="Queued messages">
            {queue.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-white/[0.1] bg-[#1b1c22] text-[12.5px] text-[#d4d4d4]"
              >
                <span className="shrink-0 text-[#8ab4f8] font-semibold">
                  {queuePaused && i === 0 ? "Paused" : "Queued"}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {m.images.length > 0 ? `🖼 ${m.images.length} · ` : ""}
                  {m.text}
                </span>
                {queuePaused && i === 0 && (
                  <button
                    type="button"
                    onClick={() => setQueuePaused(false)}
                    className="shrink-0 px-2 h-6 rounded-md bg-[#3276f2] text-white text-[12px] font-semibold"
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setQueue((q) => removeQueued(q, m.id))}
                  className="shrink-0 w-6 h-6 rounded-md hover:bg-white/[0.08] text-[#a3a3a3] flex items-center justify-center"
                  aria-label="Remove queued message"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {slashSuggestions.length > 0 && (
          <div
            role="listbox"
            aria-label="Slash commands"
            className="mb-1.5 rounded-xl border border-white/[0.1] bg-[#1b1c22] overflow-hidden"
          >
            {slashSuggestions.map((c) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  setInputText(`/${c.name} `);
                  composerRef.current?.focus();
                }}
                className="w-full flex items-baseline gap-2 px-3 py-2 text-left hover:bg-white/[0.06]"
              >
                <span className="text-[13.5px] font-mono text-[#8ab4f8]">/{c.name}</span>
                <span className="min-w-0 truncate text-[12px] text-[#a3a3a3]">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {dictation.error && (
          <div
            role="alert"
            className="mb-1.5 px-3 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12.5px] text-amber-200"
          >
            {dictation.error}
          </div>
        )}

        {sendError && (
          <div
            role="alert"
            className="mb-1.5 px-3 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[12.5px] leading-snug text-amber-200"
          >
            {sendError}
          </div>
        )}

        {(images.length > 0 || uploading > 0) && (
          <div className="mb-1.5 flex flex-wrap gap-2" aria-label="Attached images">
            {images.map((img) => (
              <div
                key={img.id}
                className="relative w-14 h-14 rounded-xl overflow-hidden border border-white/[0.14]"
              >
                <img src={img.previewUrl} alt="Attached" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center"
                  aria-label="Remove image"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {uploading > 0 && (
              <div className="w-14 h-14 rounded-xl border border-white/[0.14] flex items-center justify-center">
                <Loader2 className="w-4 h-4 animate-spin text-[#8ab4f8]" />
              </div>
            )}
          </div>
        )}

        {(usage || canSetOptions) && (
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <div
              className="min-w-0 text-[11.5px] text-[#737373] truncate"
              title={
                usage
                  ? `Input ${usage.input_tokens} · output ${usage.output_tokens} · cache read ${usage.cache_read_tokens ?? 0} · cache write ${usage.cache_creation_tokens ?? 0}`
                  : undefined
              }
            >
              {usage
                ? `Context ${formatTokens(contextTokens(usage))} tokens${usage.model ? ` · ${usage.model}` : ""}`
                : ""}
            </div>
            {canSetOptions && (
              <button
                type="button"
                onClick={() => setShowOptions(true)}
                className="shrink-0 h-7 px-2.5 rounded-lg bg-[#262626] hover:bg-[#303036] text-[12px] font-semibold text-[#d4d4d4] inline-flex items-center gap-1.5"
                aria-label="Model and effort"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Model
              </button>
            )}
          </div>
        )}

        {showOptions && surfaceId && (
          <AgentOptionsSheet
            surfaceId={surfaceId}
            agentKind={agentKind}
            currentModel={usage?.model}
            onClose={() => setShowOptions(false)}
            onOpenTerminal={onOpenTerminal}
          />
        )}

        {/* Floating Mobile Prompt Composer with Orca Rounded Capsule */}
        <div className="flex items-center gap-1.5 bg-[#1f1f23] border border-white/[0.1] rounded-[24px] px-4 py-1.5 shadow-sm">
          {/* Enter inserts a newline; only the blue arrow sends. */}
          <textarea
            ref={composerRef}
            rows={1}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              if (sendError) setSendError(null);
            }}
            onFocus={handleInputFocus}
            enterKeyHint="enter"
            placeholder={`Message ${agentDisplayName(agentKind)}...`}
            className="flex-1 bg-transparent border-0 text-[15px] leading-[22px] text-[#fafafa] placeholder-[#737373] outline-none transition-colors py-1.5 min-w-0 resize-none max-h-[132px]"
          />

          {onUploadImage && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => void handlePickImages(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={images.length + uploading >= MAX_IMAGES_PER_MESSAGE}
                className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-[#a3a3a3] hover:text-white disabled:opacity-30"
                title="Attach image"
                aria-label="Attach image"
              >
                <ImagePlus className="w-4 h-4" />
              </button>
            </>
          )}

          {canDictate() && (
            <button
              type="button"
              onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
              className={`w-9 h-9 rounded-full shrink-0 flex items-center justify-center transition-colors ${
                dictation.listening
                  ? "bg-rose-500/20 text-rose-400"
                  : "text-[#a3a3a3] hover:text-white"
              }`}
              title={dictation.listening ? "Stop dictation" : "Dictate"}
              aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
              aria-pressed={dictation.listening}
            >
              {dictation.listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}

          {/* Orca Critical Action Swap Button: Stop while agent is running; Send otherwise */}
          {isWorking && !inputText.trim() && images.length === 0 && !isSubmitting ? (
            <button
              type="button"
              onClick={handleInterrupt}
              disabled={isStopping}
              className="w-9 h-9 bg-[#262626] hover:bg-rose-950/60 hover:text-rose-400 border border-[#3b3e50] text-gray-300 rounded-full transition-colors shadow-sm shrink-0 flex items-center justify-center disabled:opacity-50"
              title={isStopping ? "Stopping..." : "Stop the agent (Ctrl+C)"}
              aria-label={isStopping ? "Stopping" : "Stop"}
            >
              {isStopping ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
              ) : (
                <Square className="w-3.5 h-3.5 fill-current text-rose-400" />
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSendPrompt}
              disabled={(!inputText.trim() && images.length === 0) || isSubmitting || uploading > 0}
              className="w-9 h-9 bg-[#3276f2] hover:bg-[#2563eb] disabled:opacity-30 text-white rounded-full transition-colors shadow-sm shrink-0 flex items-center justify-center"
              title="Send prompt"
              aria-label="Send"
            >
              {isSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
  latestAwaiting: AwaitingInput | null,
  onSend: (text: string) => Promise<void>,
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
          live={isLastTurn && toolItems.some((t) => !t.isEnd)}
        />,
      );
    }
  };

  events.forEach((ev, idx) => {
    // 1. Tool start/end -> accumulate into pendingTools for grouping
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

    // If thinking is empty, skip it completely and do NOT flush pending tools!
    // Token usage is shown in the composer, never in the timeline, and must not split a tool run.
    if (ev.kind === "usage") {
      return;
    }
    if (ev.kind === "thinking" && (!ev.text || !ev.text.trim())) {
      return;
    }

    // If delta or assistant text is empty or whitespace, skip without flushing!
    if ((ev.kind === "assistant" || ev.kind === "delta") && (!ev.text || !ev.text.trim())) {
      return;
    }

    // Flush any pending tool runs before non-tool event
    flushTools(`idx-${idx}`);

    // 2. Thinking Accordion
    if (ev.kind === "thinking") {
      renderedElements.push(
        <MobileNativeChatReasoningRow
          key={`th-${idx}`}
          id={`reasoning-${idx}`}
          text={ev.text}
          live={isLastTurn && idx === events.length - 1}
        />,
      );
      return;
    }

    // 3. Subagents Roster Card
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

    // 4. Awaiting Input Interactive Card
    if (ev.kind === "awaiting-input") {
      const isActive = isLastTurn && latestAwaiting === ev;
      if (!isActive) {
        renderedElements.push(
          <div
            key={`ask-${idx}`}
            className="p-2.5 my-1.5 rounded-xl bg-[#1a1b26] border border-[#2e303e] text-xs text-gray-400 flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate font-medium text-gray-300">
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
          onSubmit={async (resp) => {
            await onSend(resp);
          }}
        />,
      );
      return;
    }

    // 5. Assistant Text / Markdown Prose
    if (ev.kind === "assistant" || ev.kind === "delta") {
      renderedElements.push(
        <div key={`ast-${idx}`} className="py-1">
          <NativeChatProse content={ev.text} />
        </div>,
      );
      return;
    }

    // 6. Status notification
    if (ev.kind === "status") {
      renderedElements.push(
        <div key={`st-${idx}`} className="flex items-center gap-1.5 text-xs text-gray-400 py-0.5">
          <Clock className="w-3.5 h-3.5 text-indigo-400" />
          <span>{ev.text}</span>
        </div>,
      );
      return;
    }

    // 7. Error message
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

  // Flush any trailing tools
  flushTools("final");

  return renderedElements;
}
