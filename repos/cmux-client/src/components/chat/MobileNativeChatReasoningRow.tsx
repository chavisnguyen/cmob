import { memo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatChatDuration } from "../../domain/chat/taskList";
import { useChatDisclosure } from "../../state/useChatDisclosure";

interface MobileNativeChatReasoningRowProps {
  id: string;
  text: string;
  live?: boolean;
  durationSeconds?: number;
  surfaceKey?: string;
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
  id,
  text,
  live = false,
  durationSeconds,
  surfaceKey,
}: MobileNativeChatReasoningRowProps) {
  const [isExpanded, toggleExpanded] = useChatDisclosure(surfaceKey, `reasoning:${id}`, false);

  if (!text || !text.trim()) {
    return null;
  }

  let headline = "Thought";
  if (live) {
    headline = "Thinking";
  } else if (durationSeconds !== undefined && durationSeconds > 0) {
    headline = `Thought for ${formatChatDuration(durationSeconds)}`;
  }

  const preview = !isExpanded ? extractFirstLinePreview(text) : "";

  return (
    <div className="w-full my-0.5 text-[12px]">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between py-0.5 px-1 -mx-1 rounded-[5px] hover:bg-surface/80 text-muted hover:text-fg-soft transition-colors min-w-0"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-dim shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-dim shrink-0" />
          )}
          <span className="font-medium text-muted shrink-0">{headline}</span>
          {preview && (
            <span className="text-[11.5px] text-dim truncate font-sans">· {preview}</span>
          )}
          {live && (
            <span className="inline-flex rounded-full h-1.5 w-1.5 bg-fg/70 animate-pulse shrink-0" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="ml-2.5 pl-3 my-1 border-l border-line text-[12px] font-sans text-muted whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto scrollbar-thin">
          {text.trim()}
        </div>
      )}
    </div>
  );
});
