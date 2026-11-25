import { memo, useMemo, useRef, useState, type Key } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileCode, ChevronDown, ChevronUp } from "lucide-react";

const DIFF_VIRTUAL_THRESHOLD = 60;
const DIFF_LINE_HEIGHT_PX = 18;

function renderDiffLine(line: string, key: Key, fixedHeight: boolean) {
  const isHunk = line.startsWith("@@");
  const isAdd = line.startsWith("+") && !line.startsWith("+++");
  const isRem = line.startsWith("-") && !line.startsWith("---");

  let lineStyle = "text-muted";
  if (isHunk) lineStyle = "text-accent-soft/80 bg-accent/10 px-1 font-semibold";
  else if (isAdd) lineStyle = "text-emerald-300 bg-emerald-950/30 px-1";
  else if (isRem) lineStyle = "text-rose-300 bg-rose-950/30 px-1";

  return (
    <div
      key={key}
      className={`whitespace-pre font-mono ${fixedHeight ? "h-[18px] leading-[18px]" : isHunk ? "py-0.5" : ""} ${lineStyle}`}
    >
      {line || " "}
    </div>
  );
}

function VirtualizedChatDiffLines({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DIFF_LINE_HEIGHT_PX,
    overscan: 15,
    scrollMargin: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  const topSpacer = first ? Math.max(0, first.start - 8) : 0;
  const bottomSpacer = last ? Math.max(0, totalHeight - (last.end - 8)) : 0;

  return (
    <div
      ref={scrollRef}
      className="max-h-64 overflow-y-auto overflow-x-auto p-2 bg-bg text-[11px] leading-[18px] border-t border-line scrollbar-thin"
    >
      <div className="min-w-max">
        {topSpacer > 0 && (
          <div aria-hidden="true" style={{ height: topSpacer, overflowAnchor: "none" }} />
        )}
        {virtualItems.map((item) => renderDiffLine(lines[item.index] ?? "", item.key, true))}
        {bottomSpacer > 0 && (
          <div aria-hidden="true" style={{ height: bottomSpacer, overflowAnchor: "none" }} />
        )}
      </div>
    </div>
  );
}

interface MobileNativeChatDiffCardProps {
  path: string;
  diff?: string;
  added?: number;
  removed?: number;
}

export const MobileNativeChatDiffCard = memo(function MobileNativeChatDiffCard({
  path,
  diff,
  added = 0,
  removed = 0,
}: MobileNativeChatDiffCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { addCount, remCount } = useMemo(() => {
    if (added || removed || !diff) {
      return { addCount: added, remCount: removed };
    }
    let a = 0;
    let r = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) a++;
      else if (line.startsWith("-") && !line.startsWith("---")) r++;
    }
    return { addCount: a, remCount: r };
  }, [diff, added, removed]);

  const lines = useMemo(() => (isExpanded && diff ? diff.split("\n") : []), [isExpanded, diff]);

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

      {isExpanded &&
        diff &&
        (lines.length > DIFF_VIRTUAL_THRESHOLD ? (
          <VirtualizedChatDiffLines lines={lines} />
        ) : (
          <div className="max-h-64 overflow-y-auto overflow-x-auto p-2 bg-bg text-[11px] leading-relaxed border-t border-line scrollbar-thin">
            {lines.map((line, idx) => renderDiffLine(line, `d-${idx}`, false))}
          </div>
        ))}
    </div>
  );
});
