import { memo, useMemo } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { buildTimelineItemForTurn } from "../../domain/chat/chatViewModel";
import type { AssistantBlockItem, ChatTimelineItem } from "../../domain/chat/types";
import type { AgentTurn, AwaitingInput } from "../../protocol/event";
import { CollapsibleText } from "./CollapsibleText";
import { MobileNativeChatAwaitingInputRow } from "./MobileNativeChatAwaitingInputRow";
import { MobileNativeChatBackgroundTasksCard } from "./MobileNativeChatBackgroundTasksCard";
import { MobileNativeChatReasoningRow } from "./MobileNativeChatReasoningRow";
import { MobileNativeChatSubagentGroup } from "./MobileNativeChatSubagentGroup";
import { MobileNativeChatToolRun } from "./MobileNativeChatToolRun";
import { NativeChatProse } from "./NativeChatProse";

function renderAssistantBlock(block: AssistantBlockItem, surfaceKey?: string) {
  switch (block.kind) {
    case "work-run":
      return (
        <MobileNativeChatToolRun
          key={block.key}
          blockKey={block.key}
          surfaceKey={surfaceKey}
          tools={block.tools}
          steps={block.steps}
          thoughts={block.thoughts}
          totalThoughtSeconds={block.totalThoughtSeconds}
          live={block.live}
        />
      );
    case "live-reasoning":
      return (
        <MobileNativeChatReasoningRow
          key={block.key}
          id={block.id}
          surfaceKey={surfaceKey}
          text={block.text}
          durationSeconds={block.durationSeconds}
          live={block.live}
        />
      );
    case "prose":
      return (
        <div key={block.key} className="py-1">
          <NativeChatProse content={block.text} />
        </div>
      );
    case "subagents":
      return (
        <MobileNativeChatSubagentGroup
          key={block.key}
          groupId={block.groupId}
          agents={block.agents}
          surfaceKey={surfaceKey}
        />
      );
    case "background-tasks":
      return (
        <MobileNativeChatBackgroundTasksCard
          key={block.key}
          tasks={block.tasks}
          surfaceKey={surfaceKey}
          itemKey={block.key}
        />
      );
    case "awaiting-input":
      return (
        <MobileNativeChatAwaitingInputRow
          key={block.key}
          awaiting={block.awaiting}
          pending={block.pending}
        />
      );
    case "status":
      return (
        <div key={block.key} className="flex items-center gap-1.5 text-xs text-muted py-0.5">
          <Clock className="w-3.5 h-3.5 text-accent-soft" />
          <span>{block.text}</span>
        </div>
      );
    case "error":
      return (
        <div
          key={block.key}
          className="p-3 rounded-xl bg-rose-950/30 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{block.message}</span>
        </div>
      );
  }
}

export const ChatTimelineItemView = memo(function ChatTimelineItemView({
  item,
  surfaceKey,
}: {
  item: ChatTimelineItem;
  surfaceKey?: string;
}) {
  if (item.kind === "divider") {
    return (
      <div
        role="separator"
        aria-label={item.label}
        className="flex items-center gap-3 w-full py-2 my-0.5 select-none"
      >
        <div className="h-px flex-1 bg-white/[0.08]" />
        <span className="text-[11px] font-medium tracking-wide text-dim shrink-0">
          {item.label}
        </span>
        <div className="h-px flex-1 bg-white/[0.08]" />
      </div>
    );
  }

  if (item.kind === "user") {
    return (
      <div className="flex flex-col items-end w-full min-w-0 max-w-full py-1">
        <div className="max-w-[88%] lg:max-w-[75%] bg-white/[0.065] border border-white/[0.07] text-fg rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed min-w-0 break-words [overflow-wrap:anywhere] space-y-2">
          {item.imagePreviews.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.imagePreviews.map((src, idx) => (
                <img
                  key={`${item.id}-img-${idx}`}
                  src={src}
                  alt="Attached"
                  className="w-14 h-14 rounded-xl object-cover border border-white/[0.12]"
                />
              ))}
            </div>
          )}
          {item.texts.map((txt, idx) => (
            <CollapsibleText
              key={`u-${idx}`}
              text={txt}
              surfaceKey={surfaceKey}
              itemKey={`collapse:${item.id}:u-${idx}`}
              className="whitespace-pre-wrap font-sans min-w-0 break-words [overflow-wrap:anywhere]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start w-full min-w-0 max-w-full">
      <div className="w-full max-w-full min-w-0 space-y-1.5">
        {item.blocks.map((b) => renderAssistantBlock(b, surfaceKey))}
      </div>
    </div>
  );
});

export const ChatTurnRow = memo(function ChatTurnRow({
  turn,
  isLastTurn,
  isWorking,
  activeAwaiting,
  surfaceKey,
}: {
  turn: AgentTurn;
  isLastTurn: boolean;
  isWorking: boolean;
  activeAwaiting: AwaitingInput | null;
  surfaceKey?: string;
  onSubmitAwaiting?: (text: string) => Promise<void>;
}) {
  const item = useMemo(
    () =>
      buildTimelineItemForTurn({
        turn,
        isLastTurn,
        isWorking,
        activeAwaitingEventIdx: null,
        activeAwaitingRef: activeAwaiting,
      }),
    [turn, isLastTurn, isWorking, activeAwaiting],
  );

  return <ChatTimelineItemView item={item} surfaceKey={surfaceKey ?? turn.surface_id} />;
});
