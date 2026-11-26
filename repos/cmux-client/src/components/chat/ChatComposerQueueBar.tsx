import { Loader2, SlidersHorizontal, X } from "lucide-react";
import type { ComposerImageAttachment } from "../../domain/chat/composerStore";
import type { QueuedMessage } from "../../domain/chat/types";
import type { AgentLifecycleState } from "../../protocol/event";
import { queueStatusLabel } from "./chatQueue";
import type { SlashCommand } from "./slashCommands";
import { contextTokens, formatTokens, type UsageEvent } from "./usageSummary";

export function ChatComposerAttachmentsAndMenus({
  queue,
  queuePaused,
  lifecycleState,
  needsAnswer,
  isSubmitting,
  visibleSlashSuggestions,
  activeSlashIdx,
  sendError,
  images,
  uploading,
  usage,
  canSetOptions,
  onResumeQueue,
  onSendQueuedNow,
  onRemoveQueued,
  onApplySlashCommand,
  onRemoveImage,
  onOpenOptions,
}: {
  queue: readonly QueuedMessage[];
  queuePaused: boolean;
  lifecycleState: AgentLifecycleState;
  needsAnswer: boolean;
  isSubmitting: boolean;
  visibleSlashSuggestions: readonly SlashCommand[];
  activeSlashIdx: number;
  sendError: string | null;
  images: readonly ComposerImageAttachment[];
  uploading: number;
  usage: UsageEvent | null;
  canSetOptions: boolean;
  onResumeQueue: () => void;
  onSendQueuedNow: (item: QueuedMessage) => void;
  onRemoveQueued: (id: string) => void;
  onApplySlashCommand: (name: string) => void;
  onRemoveImage: (id: string) => void;
  onOpenOptions: () => void;
}) {
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
                  onClick={onResumeQueue}
                  className="shrink-0 px-2 h-6 rounded-md bg-accent text-white text-[12px] font-semibold"
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onSendQueuedNow(m)}
                className="shrink-0 px-2 h-6 rounded-md bg-white/[0.08] hover:bg-white/[0.14] text-fg text-[12px] font-medium disabled:opacity-40"
              >
                Send now
              </button>
              <button
                type="button"
                onClick={() => onRemoveQueued(m.id)}
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
              onClick={() => onApplySlashCommand(c.name)}
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
                onClick={() => onRemoveImage(img.id)}
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
              onClick={onOpenOptions}
              className="shrink-0 h-7 px-2.5 rounded-lg bg-raised hover:bg-line text-[12px] font-semibold text-fg-soft inline-flex items-center gap-1.5"
              aria-label="Model and effort"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Model
            </button>
          )}
        </div>
      )}
    </>
  );
}
