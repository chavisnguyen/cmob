import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Send, Square } from "lucide-react";
import type { AgentLifecycleState } from "../../protocol/event";
import { agentDisplayName } from "../common/agentBrand";
import { hasAgentOptions } from "./agentOptions";
import { AgentOptionsSheet } from "./AgentOptionsSheet";
import { ChatComposerAttachmentsAndMenus } from "./ChatComposerQueueBar";
import { shouldSubmitComposerKey } from "./composerKey";
import { MAX_IMAGES_PER_MESSAGE, isSupportedImageFile } from "./imageAttach";
import type { UsageEvent } from "./usageSummary";
import { useChatComposerController } from "./useChatComposerController";

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
  onSend: (text: string, imagePaths?: string[], imagePreviews?: string[]) => Promise<void>;
  onUploadImage?: (base64: string) => Promise<string>;
  onInterrupt: () => Promise<void>;
  onOpenTerminal?: () => void;
  onScrollToTail: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}

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
    const [showOptions, setShowOptions] = useState(false);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const lastCompositionEndRef = useRef(0);

    const {
      inputText,
      images,
      queue,
      queuePaused,
      isSubmitting,
      uploading,
      visibleSlashSuggestions,
      activeSlashIdx,
      setActiveSlashIdx,
      setSlashDismissed,
      setInputText,
      handlePickImages,
      removeImage,
      handleSendPrompt,
      handleSendQueuedNow,
      resumeQueue,
      removeQueuedItem,
    } = useChatComposerController({
      agentKind,
      surfaceId,
      isWorking,
      lifecycleState,
      needsAnswer,
      onSetSendError,
      onSend,
      onUploadImage,
      onScrollToTail,
      onSubmittingChange,
    });

    useLayoutEffect(() => {
      const el = composerRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    }, [inputText]);

    const pickFiles = (files: FileList | File[] | null) =>
      handlePickImages(files, () => {
        if (fileInputRef.current) fileInputRef.current.value = "";
      });

    useImperativeHandle(ref, () => ({ pickImages: pickFiles }));

    const applySlashCommand = (name: string) => {
      setInputText(`/${name} `);
      setSlashDismissed(true);
      composerRef.current?.focus();
    };

    const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

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
          lastCompositionEndAt: lastCompositionEndRef.current,
        })
      ) {
        e.preventDefault();
        void handleSendPrompt();
      }
    };

    return (
      <>
        <ChatComposerAttachmentsAndMenus
          queue={queue}
          queuePaused={queuePaused}
          lifecycleState={lifecycleState}
          needsAnswer={needsAnswer}
          isSubmitting={isSubmitting}
          visibleSlashSuggestions={visibleSlashSuggestions}
          activeSlashIdx={activeSlashIdx}
          sendError={sendError}
          images={images}
          uploading={uploading}
          usage={usage}
          canSetOptions={Boolean(surfaceId && hasAgentOptions(agentKind))}
          onResumeQueue={resumeQueue}
          onSendQueuedNow={(m) => void handleSendQueuedNow(m)}
          onRemoveQueued={removeQueuedItem}
          onApplySlashCommand={applySlashCommand}
          onRemoveImage={removeImage}
          onOpenOptions={() => setShowOptions(true)}
        />

        {showOptions && surfaceId && (
          <AgentOptionsSheet
            surfaceId={surfaceId}
            agentKind={agentKind}
            currentModel={usage?.model}
            disabledMidSession={isWorking || lifecycleState === "waiting" || needsAnswer}
            onClose={() => setShowOptions(false)}
            onOpenTerminal={onOpenTerminal}
          />
        )}

        <div className="flex items-end gap-1.5 bg-surface border border-white/[0.08] focus-within:border-white/[0.18] rounded-2xl pl-3.5 pr-1.5 py-1.5 transition-colors">
          <textarea
            ref={composerRef}
            rows={1}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              if (sendError) onSetSendError(null);
            }}
            onCompositionEnd={() => {
              lastCompositionEndRef.current =
                typeof performance !== "undefined" ? performance.now() : Date.now();
            }}
            onKeyDown={handleComposerKeyDown}
            onFocus={() => {
              if (typeof window !== "undefined") {
                requestAnimationFrame(() => {
                  window.scrollTo(0, 0);
                  document.body.scrollTop = 0;
                });
              }
            }}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files).filter(isSupportedImageFile);
              if (pasted.length === 0 || !onUploadImage) return;
              e.preventDefault();
              void pickFiles(pasted);
            }}
            enterKeyHint={isDesktop ? "send" : "enter"}
            placeholder={`Message ${agentDisplayName(agentKind)}...`}
            title={isDesktop ? "Enter to send, Shift+Enter for newline" : undefined}
            className="flex-1 bg-transparent border-0 text-[14.5px] leading-[21px] text-fg placeholder-dim outline-none py-[5px] min-w-0 resize-none max-h-[132px]"
          />

          {onUploadImage && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.heic,.heif"
                multiple
                hidden
                onChange={(e) => void pickFiles(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={images.length + uploading >= MAX_IMAGES_PER_MESSAGE}
                className="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center text-dim hover:text-fg hover:bg-white/[0.05] transition-colors disabled:opacity-30"
                title="Attach image"
                aria-label="Attach image"
              >
                <ImagePlus className="w-4 h-4" />
              </button>
            </>
          )}

          {isWorking && !inputText.trim() && images.length === 0 && !isSubmitting ? (
            <button
              type="button"
              onClick={() => void onInterrupt()}
              disabled={isStopping}
              className="w-8 h-8 bg-white/[0.06] hover:bg-rose-500/15 hover:text-rose-300 border border-white/[0.08] text-fg-soft rounded-xl transition-colors shrink-0 flex items-center justify-center disabled:opacity-50"
              title={isStopping ? "Stopping..." : "Stop the agent (Escape)"}
              aria-label={isStopping ? "Stopping" : "Stop"}
            >
              {isStopping ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
              ) : (
                <Square className="w-3 h-3 fill-current text-rose-400" />
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSendPrompt()}
              disabled={(!inputText.trim() && images.length === 0) || isSubmitting || uploading > 0}
              className="w-8 h-8 bg-accent hover:bg-accent-strong disabled:bg-white/[0.04] disabled:text-dim text-white rounded-xl transition-colors shrink-0 flex items-center justify-center"
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
      </>
    );
  }),
);
