/**
 * Orca-style Reasoning / Thought Disclosure Row
 *
 * Matches `ref/orca/src/shared/native-chat/transcript/native-chat-reasoning-row.ts`:
 * - Live: `"Reasoning"`
 * - Settled with duration: `"Thought for 15s"`
 * - Settled without duration: `"Thought"`
 * Never displays mechanical character counts like `(755 chars)`.
 */

import { memo, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { formatChatDuration } from "./taskList";

interface MobileNativeChatReasoningRowProps {
  id: string;
  text: string;
  live?: boolean;
  durationSeconds?: number;
}

function extractFirstLinePreview(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return firstLine.replace(/^[*#>-]+\s*/, "").trim();
}

export const MobileNativeChatReasoningRow = memo(function MobileNativeChatReasoningRow({
  id: _id,
  text,
  live = false,
  durationSeconds,
}: MobileNativeChatReasoningRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!text || !text.trim()) {
    return null;
  }

  let headline = "Thought";
  if (live) {
    headline = "Reasoning";
  } else if (durationSeconds !== undefined && durationSeconds > 0) {
    headline = `Thought for ${formatChatDuration(durationSeconds)}`;
  }

  const preview = !isExpanded ? extractFirstLinePreview(text) : "";

  return (
    <div className="w-full my-0.5 text-xs">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between py-1 px-1 rounded-md hover:bg-white/[0.04] text-muted hover:text-fg-soft transition-colors min-w-0"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          )}
          <Brain
            className={`w-3.5 h-3.5 shrink-0 ${live ? "text-accent-soft animate-pulse" : "text-muted"}`}
          />
          <span className="font-medium text-fg-soft shrink-0">{headline}</span>
          {preview && (
            <span className="text-[11.5px] text-dim truncate font-sans">· {preview}</span>
          )}
          {live && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-soft opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
            </span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="ml-5 pl-3 my-1 border-l border-white/10 text-[12px] font-sans text-muted whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto scrollbar-thin">
          {text.trim()}
        </div>
      )}
    </div>
  );
});
