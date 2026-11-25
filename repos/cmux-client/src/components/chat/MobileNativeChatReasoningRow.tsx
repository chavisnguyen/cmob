import { memo, useState } from "react";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";

interface MobileNativeChatReasoningRowProps {
  id: string;
  text: string;
  live?: boolean;
  durationSeconds?: number;
}

export const MobileNativeChatReasoningRow = memo(function MobileNativeChatReasoningRow({
  id: _id,
  text,
  live = false,
  durationSeconds,
}: MobileNativeChatReasoningRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // If text is empty or only whitespace, do not render an empty row
  if (!text || !text.trim()) {
    return null;
  }

  // Derive Orca-style headline
  let headline = "Thought";
  if (live) {
    headline = "Reasoning";
  } else if (durationSeconds !== undefined && durationSeconds > 0) {
    const formatted =
      durationSeconds < 60
        ? `${Math.round(durationSeconds)}s`
        : `${Math.floor(durationSeconds / 60)}m ${Math.round(durationSeconds % 60)}s`;
    headline = `Thought for ${formatted}`;
  }

  return (
    <div className="w-full my-0.5 text-xs">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between py-1 px-1 rounded-md hover:bg-white/[0.04] text-muted hover:text-fg-soft transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Brain
            className={`w-3.5 h-3.5 shrink-0 ${live ? "text-accent-soft animate-pulse" : "text-muted"}`}
          />
          <span className="font-medium text-fg-soft truncate">{headline}</span>
          <span className="text-[10px] text-dim font-mono">
            ({text.length.toLocaleString()} chars)
          </span>
          {live && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-soft opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
            </span>
          )}
        </div>
        <div className="shrink-0 ml-2">
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="ml-5 pl-2.5 my-1 border-l border-white/10 text-[11px] font-mono text-muted whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto scrollbar-thin">
          {text}
        </div>
      )}
    </div>
  );
});
