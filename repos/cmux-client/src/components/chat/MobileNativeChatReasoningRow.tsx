import { useState } from "react";
import { Brain, ChevronDown, ChevronUp } from "lucide-react";

interface MobileNativeChatReasoningRowProps {
  id: string;
  text: string;
  live?: boolean;
  durationSeconds?: number;
}

export function MobileNativeChatReasoningRow({
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
        className="w-full flex items-center justify-between py-1 px-1 rounded-md hover:bg-white/[0.04] text-gray-400 hover:text-gray-300 transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Brain
            className={`w-3.5 h-3.5 shrink-0 ${live ? "text-purple-400 animate-pulse" : "text-gray-400"}`}
          />
          <span className="font-medium text-gray-300 truncate">{headline}</span>
          <span className="text-[10px] text-gray-500 font-mono">
            ({text.length.toLocaleString()} chars)
          </span>
          {live && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-purple-500" />
            </span>
          )}
        </div>
        <div className="shrink-0 ml-2">
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="ml-5 pl-2.5 my-1 border-l border-white/10 text-[11px] font-mono text-gray-400 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto scrollbar-thin">
          {text}
        </div>
      )}
    </div>
  );
}
