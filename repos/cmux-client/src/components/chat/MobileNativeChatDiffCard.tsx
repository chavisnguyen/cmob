import { memo, useMemo, useRef, type Key } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, FileCode } from "lucide-react";
import { useChatDisclosure } from "../../state/useChatDisclosure";

const DIFF_VIRTUAL_THRESHOLD = 60;
const DIFF_LINE_HEIGHT_PX = 18;

function renderDiffLine(line: string, key: Key, fixedHeight: boolean) {
  const isHunk = line.startsWith("@@");
  const isAdd = line.startsWith("+") && !line.startsWith("+++");
  const isRem = line.startsWith("-") && !line.startsWith("---");

  let lineStyle = "text-muted";
  if (isHunk) lineStyle = "text-dim bg-surface px-1.5";
  else if (isAdd) lineStyle = "text-status-ok bg-status-ok/10 px-1.5";
  else if (isRem) lineStyle = "text-status-err bg-status-err/10 px-1.5";

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
      className="max-h-60 overflow-y-auto overflow-x-auto p-2 bg-[#10100f] text-[11px] leading-[18px] border-t border-line scrollbar-thin"
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
  surfaceKey?: string;
  itemKey?: string;
}

export const MobileNativeChatDiffCard = memo(function MobileNativeChatDiffCard({
  path,
  diff,
  added = 0,
  removed = 0,
  surfaceKey,
  itemKey,
}: MobileNativeChatDiffCardProps) {
  const [isExpanded, toggleExpanded] = useChatDisclosure(
    surfaceKey,
    `diff:${itemKey ?? path}`,
    false,
  );

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
    <div className="w-full rounded-md border border-line bg-sidebar text-[11.5px] font-mono overflow-hidden my-1">
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-surface text-fg-soft transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
          <FileCode className="w-3.5 h-3.5 text-dim shrink-0" />
          <span className="text-fg-soft truncate">{path}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[11px]">
          {addCount > 0 && <span className="text-status-ok">+{addCount}</span>}
          {remCount > 0 && <span className="text-status-err">-{remCount}</span>}
          {diff &&
            (isExpanded ? (
              <ChevronUp className="w-3 h-3 text-dim" />
            ) : (
              <ChevronDown className="w-3 h-3 text-dim" />
            ))}
        </div>
      </button>

      {isExpanded &&
        diff &&
        (lines.length > DIFF_VIRTUAL_THRESHOLD ? (
          <VirtualizedChatDiffLines lines={lines} />
        ) : (
          <div className="max-h-60 overflow-y-auto overflow-x-auto p-2 bg-[#10100f] text-[11px] leading-relaxed border-t border-line scrollbar-thin">
            {lines.map((line, idx) => renderDiffLine(line, `d-${idx}`, false))}
          </div>
        ))}
    </div>
  );
});
