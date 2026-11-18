import { useState } from "react";
import { FileCode, ChevronDown, ChevronUp } from "lucide-react";

interface MobileNativeChatDiffCardProps {
  path: string;
  diff?: string;
  added?: number;
  removed?: number;
}

export function MobileNativeChatDiffCard({
  path,
  diff,
  added = 0,
  removed = 0,
}: MobileNativeChatDiffCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // If added/removed not passed, compute from diff lines
  let addCount = added;
  let remCount = removed;
  if (!addCount && !remCount && diff) {
    const lines = diff.split("\n");
    for (const l of lines) {
      if (l.startsWith("+") && !l.startsWith("+++")) addCount++;
      else if (l.startsWith("-") && !l.startsWith("---")) remCount++;
    }
  }

  const lines = diff ? diff.split("\n") : [];

  return (
    <div className="w-full rounded-lg border border-line bg-bg text-xs font-mono overflow-hidden my-1.5 shadow-sm">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 bg-surface hover:bg-raised text-fg-soft transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <FileCode className="w-4 h-4 text-accent-soft shrink-0" />
          <span className="font-semibold text-fg-soft truncate">{path}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {addCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-400">
              +{addCount}
            </span>
          )}
          {remCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-rose-500/10 text-rose-400">
              -{remCount}
            </span>
          )}
          {diff &&
            (isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            ))}
        </div>
      </button>

      {isExpanded && diff && (
        <div className="max-h-64 overflow-y-auto overflow-x-auto p-2 bg-bg text-[11px] leading-relaxed border-t border-line scrollbar-thin">
          {lines.map((line, idx) => {
            const isHunk = line.startsWith("@@");
            const isAdd = line.startsWith("+") && !line.startsWith("+++");
            const isRem = line.startsWith("-") && !line.startsWith("---");

            let lineStyle = "text-muted";
            if (isHunk) lineStyle = "text-accent-soft/80 bg-accent/10 py-0.5 px-1 font-semibold";
            else if (isAdd) lineStyle = "text-emerald-300 bg-emerald-950/30 px-1";
            else if (isRem) lineStyle = "text-rose-300 bg-rose-950/30 px-1";

            return (
              <div key={`d-${idx}`} className={`whitespace-pre font-mono ${lineStyle}`}>
                {line || " "}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
