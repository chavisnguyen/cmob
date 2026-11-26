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
        <div className="mb-1 space-y-1" aria-label="Queued messages">
          {queue.map((m, i) => (
            <div
              key={m.id}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-line bg-sidebar text-[12px] text-fg-soft"
            >
              <span className="shrink-0 text-muted font-mono text-[11px]">
                {queueStatusLabel({ index: i, queuePaused, lifecycleState, needsAnswer })}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {m.images.length > 0 ? `[${m.images.length} img] ` : ""}
                {m.text}
              </span>
              {queuePaused && i === 0 && (
                <button
                  type="button"
                  onClick={onResumeQueue}
                  className="shrink-0 px-2 h-5 rounded bg-fg text-bg text-[11px] font-medium"
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onSendQueuedNow(m)}
                className="shrink-0 px-2 h-5 rounded bg-raised hover:bg-line-strong text-fg text-[11px] font-medium disabled:opacity-40"
              >
                Send now
              </button>
              <button
                type="button"
                onClick={() => onRemoveQueued(m.id)}
                className="shrink-0 w-5 h-5 rounded hover:bg-raised text-dim hover:text-fg flex items-center justify-center"
                aria-label="Remove queued message"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {visibleSlashSuggestions.length > 0 && (
        <div
          role="listbox"
          aria-label="Slash commands"
          className="mb-1 rounded-lg border border-line-strong bg-surface overflow-hidden shadow-lg"
        >
          {visibleSlashSuggestions.map((c, idx) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={idx === activeSlashIdx}
              onClick={() => onApplySlashCommand(c.name)}
              className={`w-full flex items-baseline gap-2.5 px-3 py-1.5 text-left transition-colors ${
                idx === activeSlashIdx ? "bg-raised text-fg" : "hover:bg-sidebar text-fg-soft"
              }`}
            >
              <span className="text-[12.5px] font-mono text-fg">/{c.name}</span>
              <span className="min-w-0 truncate text-[11.5px] text-muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}

      {sendError && (
        <div
          role="alert"
          className="mb-1 px-2.5 py-1.5 rounded-lg border border-status-wait/30 bg-status-wait/10 text-[12px] leading-snug text-status-wait"
        >
          {sendError}
        </div>
      )}

      {(images.length > 0 || uploading > 0) && (
        <div className="mb-1 flex flex-wrap gap-1.5" aria-label="Attached images">
          {images.map((img) => (
            <div
              key={img.id}
              className="relative w-12 h-12 rounded-md overflow-hidden border border-line-strong"
            >
              <img src={img.previewUrl} alt="Attached" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => onRemoveImage(img.id)}
                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/75 text-white flex items-center justify-center"
                aria-label="Remove image"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
          {uploading > 0 && (
            <div className="w-12 h-12 rounded-md border border-line-strong flex items-center justify-center">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted" />
            </div>
          )}
        </div>
      )}

      {(usage || canSetOptions) && (
        <div className="mb-0.5 px-1 flex items-center justify-between gap-2">
          <div
            className="min-w-0 text-[11px] font-mono text-dim truncate"
            title={
              usage
                ? `Input ${usage.input_tokens} · output ${usage.output_tokens} · cache read ${usage.cache_read_tokens ?? 0} · cache write ${usage.cache_creation_tokens ?? 0}`
                : undefined
            }
          >
            {usage
              ? `${formatTokens(contextTokens(usage))} ctx${usage.model ? ` · ${usage.model}` : ""}`
              : ""}
          </div>
          {canSetOptions && (
            <button
              type="button"
              onClick={onOpenOptions}
              className="shrink-0 h-6 px-2 rounded-[5px] hover:bg-raised text-[11.5px] font-medium text-muted hover:text-fg inline-flex items-center gap-1 transition-colors"
              aria-label="Model and effort"
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span>Model</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
