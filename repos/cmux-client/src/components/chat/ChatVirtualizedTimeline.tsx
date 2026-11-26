import type { VirtualItem } from "@tanstack/react-virtual";
import { ChevronUp, Loader2 } from "lucide-react";
import type { ChatTimelineItem, LiveActivityLineState } from "../../domain/chat/types";
import type { ConnectionState } from "../../transport/wsClient";
import { agentDisplayName } from "../common/agentBrand";
import { AgentIcon } from "../common/AgentIcon";
import { ChatTimelineItemView } from "./ChatTimelineRow";
import { NativeChatJumpToLatest } from "./NativeChatJumpToLatest";
import { NativeChatTurnActivityLine } from "./NativeChatTurnActivityLine";

export interface ChatVirtualizedTimelineProps {
  timeline: readonly ChatTimelineItem[];
  virtualItems: readonly VirtualItem[];
  totalVirtualHeight: number;
  scrollMargin: number;
  measureElement: (node: Element | null) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  sizerRef: React.RefObject<HTMLDivElement | null>;
  bottomAnchorRef: React.RefObject<HTMLDivElement | null>;
  agentKind: string;
  surfaceId?: string;
  effectivelyWorking: boolean;
  liveActivity: LiveActivityLineState;
  hasEarlier: boolean;
  isLoading: boolean;
  isSyncing?: boolean;
  connState?: ConnectionState;
  isLoadingOlder: boolean;
  isScrolledUp: boolean;
  onScroll: () => void;
  onLoadEarlier: () => void;
  onJumpToTail: () => void;
}

export function ChatVirtualizedTimeline({
  timeline,
  virtualItems,
  totalVirtualHeight,
  scrollMargin,
  measureElement,
  scrollContainerRef,
  contentRef,
  sizerRef,
  bottomAnchorRef,
  agentKind,
  surfaceId,
  effectivelyWorking,
  liveActivity,
  hasEarlier,
  isLoading,
  isSyncing = false,
  connState = "connected",
  isLoadingOlder,
  isScrolledUp,
  onScroll,
  onLoadEarlier,
  onJumpToTail,
}: ChatVirtualizedTimelineProps) {
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const topSpacerHeight = firstVirtualItem ? Math.max(0, firstVirtualItem.start - scrollMargin) : 0;
  const bottomSpacerHeight = lastVirtualItem
    ? Math.max(0, totalVirtualHeight - (lastVirtualItem.end - scrollMargin))
    : 0;

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <div
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
      >
        <div
          className={`text-white opacity-[0.07] ${effectivelyWorking ? "cmux-watermark-breathe" : ""}`}
          data-testid="chat-watermark"
        >
          <AgentIcon kind={agentKind} size={200} className="w-[min(46vw,200px)] h-auto" />
        </div>
      </div>

      {timeline.length > 0 && isSyncing && (
        <div
          role="status"
          aria-live="polite"
          data-testid="chat-syncing-pill"
          className="pointer-events-none absolute top-2.5 inset-x-0 z-20 flex justify-center px-3"
        >
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface/95 backdrop-blur-md border border-white/[0.1] shadow-md text-[11.5px] font-medium text-fg-soft">
            <Loader2 className="w-3 h-3 animate-spin text-accent-soft shrink-0" />
            <span>{connState === "connected" ? "Syncing latest…" : "Reconnecting…"}</span>
          </div>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={onScroll}
        className="relative h-full overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-2.5 scrollbar-sleek [overflow-anchor:none] min-w-0 max-w-full select-text"
      >
        <div
          ref={contentRef}
          className="min-h-full flex flex-col justify-end min-w-0 max-w-4xl mx-auto w-full"
        >
          {hasEarlier && (
            <div className="flex justify-center py-1.5 pb-2 shrink-0">
              <button
                type="button"
                onClick={onLoadEarlier}
                disabled={isLoadingOlder}
                className="flex items-center gap-1 px-3 py-1 rounded-full bg-surface hover:bg-raised border border-line text-[11px] text-muted hover:text-fg-soft transition-colors shadow-sm"
              >
                <ChevronUp className="w-3 h-3 text-muted" />
                <span>
                  {isLoadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                </span>
              </button>
            </div>
          )}

          {timeline.length === 0 && isLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-6 text-dim my-auto"
            >
              <Loader2 className="w-6 h-6 animate-spin text-accent-soft mb-2.5" />
              <p className="text-sm font-medium text-fg-soft">Loading conversation…</p>
            </div>
          ) : timeline.length === 0 ? (
            <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-center p-6 text-dim my-auto">
              <p className="text-sm font-medium text-fg-soft">
                Active Session with {agentDisplayName(agentKind)}
              </p>
              <p className="text-xs text-dim mt-1 max-w-xs">
                Direct bidirectional chat control connected to cmux host.
              </p>
            </div>
          ) : (
            <div ref={sizerRef} className="w-full min-w-0">
              {topSpacerHeight > 0 && (
                <div
                  aria-hidden="true"
                  style={{ height: topSpacerHeight, overflowAnchor: "none" }}
                />
              )}
              {(() => {
                let previousEnd = firstVirtualItem ? firstVirtualItem.start : scrollMargin;
                return virtualItems.map((virtualItem) => {
                  const item = timeline[virtualItem.index];
                  if (!item) return null;
                  const gapHeight = Math.max(0, virtualItem.start - previousEnd);
                  previousEnd = virtualItem.end;
                  return (
                    <div key={virtualItem.key} className="w-full min-w-0">
                      {gapHeight > 0 && (
                        <div
                          aria-hidden="true"
                          style={{ height: gapHeight, overflowAnchor: "none" }}
                        />
                      )}
                      <div
                        data-index={virtualItem.index}
                        ref={measureElement}
                        className="flow-root w-full min-w-0"
                      >
                        <ChatTimelineItemView item={item} surfaceKey={surfaceId} />
                      </div>
                    </div>
                  );
                });
              })()}
              {bottomSpacerHeight > 0 && (
                <div
                  aria-hidden="true"
                  style={{ height: bottomSpacerHeight, overflowAnchor: "none" }}
                />
              )}
            </div>
          )}

          {liveActivity.visible && (
            <div className="w-full flex justify-start pt-2 my-0.5 pl-1 min-w-0 max-w-full">
              <NativeChatTurnActivityLine
                activityText={liveActivity.activityText}
                stopping={liveActivity.stopping}
              />
            </div>
          )}

          <div ref={bottomAnchorRef} className="h-px w-full" />
        </div>
      </div>
      <NativeChatJumpToLatest visible={isScrolledUp} onJump={onJumpToTail} />
    </div>
  );
}
