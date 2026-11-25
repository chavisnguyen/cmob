import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImagePlus, Loader2, Send, SlidersHorizontal, Square, X } from "lucide-react";
import type { AgentLifecycleState } from "../../protocol/event";
import { agentDisplayName } from "../common/agentBrand";
import {
  DRAIN_SETTLE_MS,
  canDrain,
  enqueue,
  queueStatusLabel,
  removeQueued,
  type QueuedMessage,
} from "./chatQueue";
import { suggestSlashCommands } from "./slashCommands";
import { MAX_IMAGES_PER_MESSAGE, PartialSendError, prepareImageForUpload } from "./imageAttach";
import { contextTokens, formatTokens, type UsageEvent } from "./usageSummary";
import { hasAgentOptions } from "./agentOptions";
import { AgentOptionsSheet } from "./AgentOptionsSheet";
import { shouldSubmitComposerKey } from "./composerKey";

export interface ChatComposerHandle {
  pickImages: (files: FileList | File[] | null) => Promise<void>;
}

interface ChatComposerProps {
  agentKind: string;
  surfaceId?: string;
  isWorking: boolean;
  lifecycleState: AgentLifecycleState;
  needsAnswer: boolean;
  usage: UsageEvent | null;
  isDesktop: boolean;
  isStopping: boolean;
  sendError: string | null;
  onSetSendError: (msg: string | null) => void;
  onSend: (text: string, imagePaths?: string[]) => Promise<void>;
  onUploadImage?: (base64: string) => Promise<string>;
  onInterrupt: () => Promise<void>;
  onOpenTerminal?: () => void;
  onScrollToTail: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}

/**
 * Isolated composer + queue + attachment bar so typing keystrokes never re-renders the chat turn list.
 */
export const ChatComposer = memo(
  forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
    {
      agentKind,
      surfaceId,
      isWorking,
      lifecycleState,
      needsAnswer,
      usage,
      isDesktop,
      isStopping,
      sendError,
      onSetSendError,
      onSend,
      onUploadImage,
      onInterrupt,
      onOpenTerminal,
      onScrollToTail,
      onSubmittingChange,
    },
    ref,
  ) {
    const [inputText, setInputText] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [images, setImages] = useState<Array<{ id: string; path: string; previewUrl: string }>>(
      [],
    );
    const [uploading, setUploading] = useState(0);
    const [queue, setQueue] = useState<QueuedMessage[]>([]);
    const [queuePaused, setQueuePaused] = useState(false);
    const [showOptions, setShowOptions] = useState(false);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const [activeSlashIdx, setActiveSlashIdx] = useState(0);

    const composerRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const queueRef = useRef(queue);
    const drainingRef = useRef(false);
    const deliveredRef = useRef(0);
    const imagesRef = useRef(images);

    useEffect(() => {
      queueRef.current = queue;
    }, [queue]);

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

    // Auto-grow the composer up to ~6 lines without triggering outer chat timeline re-renders.
    useLayoutEffect(() => {
      const el = composerRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    }, [inputText]);

    const updateSubmitting = (next: boolean) => {
      setIsSubmitting(next);
      onSubmittingChange(next);
    };

    const sendNow = async (text: string, imagePaths: string[] = []): Promise<boolean> => {
      deliveredRef.current = 0;
      onSetSendError(null);
      updateSubmitting(true);
      try {
        await onSend(text, imagePaths);
        onScrollToTail();
        return true;
      } catch (err) {
        console.warn("Send failed:", err);
        if (err instanceof PartialSendError) deliveredRef.current = err.delivered;
        onSetSendError(err instanceof Error ? err.message : "Could not send the message.");
        return false;
      } finally {
        updateSubmitting(false);
      }
    };

    const handlePickImages = async (files: FileList | File[] | null) => {
      if (!files || !onUploadImage) return;
      const room = MAX_IMAGES_PER_MESSAGE - images.length - uploading;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      if (files.length > picked.length) {
        onSetSendError(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images.`);
      }
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
          onSetSendError(err instanceof Error ? err.message : "Could not upload the image.");
        } finally {
          setUploading((n) => n - 1);
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };

    useImperativeHandle(ref, () => ({
      pickImages: handlePickImages,
    }));

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
      if (isWorking || lifecycleState === "waiting" || needsAnswer) {
        setQueue((q) =>
          enqueue(q, text, `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, paths),
        );
        sent.forEach((i) => URL.revokeObjectURL(i.previewUrl));
        return;
      }
      if (await sendNow(text, paths)) {
        sent.forEach((i) => URL.revokeObjectURL(i.previewUrl));
        return;
      }
      const remaining = sent.slice(deliveredRef.current);
      setInputText((current) => (current && current !== text ? `${text}\n${current}` : text));
      setImages((cur) => [...remaining, ...cur].slice(0, MAX_IMAGES_PER_MESSAGE));
    };

    const handleSendQueuedNow = async (item: QueuedMessage) => {
      if (drainingRef.current || isSubmitting) return;
      drainingRef.current = true;
      setQueue((q) => removeQueued(q, item.id));
      try {
        const ok = await sendNow(item.text, item.images);
        if (ok) {
          setQueuePaused(false);
        } else {
          setQueue((q) => [{ ...item, images: item.images.slice(deliveredRef.current) }, ...q]);
          setQueuePaused(true);
        }
      } finally {
        drainingRef.current = false;
      }
    };

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
          setQueue((q) => [{ ...head, images: head.images.slice(deliveredRef.current) }, ...q]);
          setQueuePaused(true);
        }
        drainingRef.current = false;
      }, DRAIN_SETTLE_MS);
      return () => clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [queue, queuePaused, isWorking, isSubmitting, lifecycleState, needsAnswer]);

    const canSetOptions = !!surfaceId && hasAgentOptions(agentKind);

    const slashSuggestions = useMemo(
      () => suggestSlashCommands(agentKind, inputText),
      [agentKind, inputText],
    );

    useEffect(() => {
      setSlashDismissed(false);
      setActiveSlashIdx(0);
    }, [inputText, agentKind]);

    const visibleSlashSuggestions = slashDismissed ? [] : slashSuggestions;

    const applySlashCommand = (name: string) => {
      setInputText(`/${name} `);
      setSlashDismissed(true);
      composerRef.current?.focus();
    };

    const handleInputFocus = () => {
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          window.scrollTo(0, 0);
          document.body.scrollTop = 0;
        });
      }
    };

    const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isIme = e.nativeEvent.isComposing || e.keyCode === 229;
      if (isIme) return;

      if (visibleSlashSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveSlashIdx((i) => (i + 1) % visibleSlashSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveSlashIdx(
            (i) => (i - 1 + visibleSlashSuggestions.length) % visibleSlashSuggestions.length,
          );
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashDismissed(true);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          const picked = visibleSlashSuggestions[activeSlashIdx] ?? visibleSlashSuggestions[0];
          if (picked) {
            e.preventDefault();
            applySlashCommand(picked.name);
            return;
          }
        }
      }

      if (
        shouldSubmitComposerKey({
          key: e.key,
          shiftKey: e.shiftKey,
          isComposing: e.nativeEvent.isComposing,
          keyCode: e.keyCode,
          isDesktop,
          hasSlashMenu: visibleSlashSuggestions.length > 0,
        })
      ) {
        e.preventDefault();
        void handleSendPrompt();
      }
    };

    return (
      <>
        {queue.length > 0 && (
          <div className="mb-1.5 space-y-1" aria-label="Queued messages">
            {queue.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-white/[0.1] bg-surface text-[12.5px] text-fg-soft"
              >
                <span className="shrink-0 text-accent-soft font-semibold">
                  {queueStatusLabel({ index: i, queuePaused, lifecycleState, needsAnswer })}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {m.images.length > 0 ? `🖼 ${m.images.length} · ` : ""}
                  {m.text}
                </span>
                {queuePaused && i === 0 && (
                  <button
                    type="button"
                    onClick={() => setQueuePaused(false)}
                    className="shrink-0 px-2 h-6 rounded-md bg-accent text-white text-[12px] font-semibold"
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void handleSendQueuedNow(m)}
                  className="shrink-0 px-2 h-6 rounded-md bg-white/[0.08] hover:bg-white/[0.14] text-fg text-[12px] font-medium disabled:opacity-40"
                >
                  Send now
                </button>
                <button
                  type="button"
                  onClick={() => setQueue((q) => removeQueued(q, m.id))}
                  className="shrink-0 w-6 h-6 rounded-md hover:bg-white/[0.08] text-muted flex items-center justify-center"
                  aria-label="Remove queued message"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {visibleSlashSuggestions.length > 0 && (
          <div
            role="listbox"
            aria-label="Slash commands"
            className="mb-1.5 rounded-xl border border-white/[0.1] bg-surface overflow-hidden"
          >
            {visibleSlashSuggestions.map((c, idx) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={idx === activeSlashIdx}
                onClick={() => applySlashCommand(c.name)}
                className={`w-full flex items-baseline gap-2 px-3 py-2 text-left transition-colors ${
                  idx === activeSlashIdx ? "bg-white/[0.08]" : "hover:bg-white/[0.06]"
                }`}
              >
                <span className="text-[13.5px] font-mono text-accent-soft">/{c.name}</span>
                <span className="min-w-0 truncate text-[12px] text-muted">{c.description}</span>
              </button>
            ))}
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
                <Loader2 className="w-4 h-4 animate-spin text-accent-soft" />
              </div>
            )}
          </div>
        )}

        {(usage || canSetOptions) && (
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <div
              className="min-w-0 text-[11.5px] text-dim truncate"
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
                className="shrink-0 h-7 px-2.5 rounded-lg bg-raised hover:bg-line text-[12px] font-semibold text-fg-soft inline-flex items-center gap-1.5"
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
        <div className="flex items-end gap-1 bg-surface border border-line rounded-[24px] pl-4 pr-1.5 py-1.5">
          <textarea
            ref={composerRef}
            rows={1}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              if (sendError) onSetSendError(null);
            }}
            onKeyDown={handleComposerKeyDown}
            onFocus={handleInputFocus}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (pasted.length === 0 || !onUploadImage) return;
              e.preventDefault();
              void handlePickImages(pasted);
            }}
            enterKeyHint={isDesktop ? "send" : "enter"}
            placeholder={
              isDesktop
                ? `Message ${agentDisplayName(agentKind)} (Enter to send, Shift+Enter for newline)...`
                : `Message ${agentDisplayName(agentKind)}...`
            }
            className="flex-1 bg-transparent border-0 text-[15px] leading-[22px] text-fg placeholder-dim outline-none transition-colors py-[7px] min-w-0 resize-none max-h-[132px]"
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
                className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-muted hover:text-white disabled:opacity-30"
                title="Attach image"
                aria-label="Attach image"
              >
                <ImagePlus className="w-[18px] h-[18px]" />
              </button>
            </>
          )}

          {isWorking && !inputText.trim() && images.length === 0 && !isSubmitting ? (
            <button
              type="button"
              onClick={() => void onInterrupt()}
              disabled={isStopping}
              className="w-9 h-9 bg-raised hover:bg-rose-950/60 hover:text-rose-400 border border-line text-fg-soft rounded-full transition-colors shadow-sm shrink-0 flex items-center justify-center disabled:opacity-50"
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
              onClick={() => void handleSendPrompt()}
              disabled={(!inputText.trim() && images.length === 0) || isSubmitting || uploading > 0}
              className="w-9 h-9 bg-accent hover:bg-accent-strong disabled:bg-raised disabled:text-dim text-white rounded-full transition-colors shrink-0 flex items-center justify-center"
              title="Send prompt"
              aria-label="Send"
            >
              {isSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-[18px] h-[18px]" />
              )}
            </button>
          )}
        </div>
      </>
    );
  }),
);
