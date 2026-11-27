import type {
  AgentLifecycleState,
  AgentTurn,
  AwaitingInput,
  BackgroundTaskEntry,
  StartupDialogInfo,
  SubagentEntry,
} from "../../protocol/event";
import { cleanUserPrompt } from "./cleanPrompt";
import { selectComposerDock } from "./dockSelector";
import { resolveSystemDividerLabel } from "./heightEstimator";
import { computeEffectivelyWorking, selectLiveActivityLine } from "./liveStatus";
import type {
  ChatTimelineItem,
  ComposerDockState,
  LiveActivityLineState,
  PendingSendItem,
} from "./types";
import { buildAssistantBlocks } from "./workRunGrouping";

export interface ChatViewModel {
  timeline: ChatTimelineItem[];
  dock: ComposerDockState;
  liveActivity: LiveActivityLineState;
  effectivelyWorking: boolean;
  latestAwaiting: AwaitingInput | null;
  effectiveAwaiting: AwaitingInput | null;
  needsAnswer: boolean;
}

export function buildTimelineItemForTurn(params: {
  turn: AgentTurn;
  isLastTurn: boolean;
  isWorking: boolean;
  activeAwaitingEventIdx: number | null;
  activeAwaitingRef: AwaitingInput | null;
  pendingMeta?: PendingSendItem;
}): ChatTimelineItem {
  const { turn, isLastTurn, isWorking, activeAwaitingEventIdx, activeAwaitingRef, pendingMeta } =
    params;

  const dividerLabel = resolveSystemDividerLabel(turn);
  if (dividerLabel !== null) {
    return {
      kind: "divider",
      id: turn.id,
      turn,
      label: dividerLabel,
    };
  }

  if (turn.role === "user") {
    const texts: string[] = [];
    for (const ev of turn.events) {
      if (ev.kind === "user") {
        const cleaned = cleanUserPrompt(ev.text);
        if (cleaned) texts.push(cleaned);
      }
    }
    return {
      kind: "user",
      id: turn.id,
      turn,
      texts,
      imagePreviews: pendingMeta?.imagePreviews ?? [],
      pending: Boolean(pendingMeta),
    };
  }

  return {
    kind: "assistant",
    id: turn.id,
    turn,
    blocks: buildAssistantBlocks({
      turnId: turn.id,
      events: turn.events,
      isLastTurn,
      isWorking,
      activeAwaitingEventIdx: isLastTurn ? activeAwaitingEventIdx : null,
      activeAwaitingRef: isLastTurn ? activeAwaitingRef : null,
    }),
    isLastTurn,
    isWorking,
  };
}

/**
 * Pure builder producing the complete Chat ViewModel (`timeline`, `dock`, `liveActivity`,
 * `effectivelyWorking`, `effectiveAwaiting`) from raw turns and session status.
 */
export function buildChatViewModel(params: {
  turns: readonly AgentTurn[];
  pendingSends?: readonly PendingSendItem[];
  surfaceId?: string;
  isWorking: boolean;
  withinGrace?: boolean;
  lifecycleState?: AgentLifecycleState;
  activityText?: string | null;
  awaitingPrompt?: string | null;
  startupDialog?: StartupDialogInfo | null;
  snapshotConfirmed?: boolean;
  isSubmitting?: boolean;
  isStopping?: boolean;
  activeSubagents?: readonly SubagentEntry[];
  activeBackgroundTasks?: readonly BackgroundTaskEntry[];
}): ChatViewModel {
  const {
    turns,
    pendingSends = [],
    surfaceId = "default",
    isWorking,
    withinGrace = false,
    lifecycleState = "idle",
    activityText = null,
    awaitingPrompt = null,
    startupDialog = null,
    snapshotConfirmed = true,
    isSubmitting = false,
    isStopping = false,
    activeSubagents = [],
    activeBackgroundTasks = [],
  } = params;

  const { dock, latestAwaitingMatch, effectiveAwaiting } = selectComposerDock({
    turns,
    isWorking,
    lifecycleState,
    startupDialog,
    awaitingPrompt,
    snapshotConfirmed,
  });

  const effectivelyWorking = computeEffectivelyWorking({
    isWorking,
    withinGrace,
    snapshotConfirmed,
    startupDialog: snapshotConfirmed ? startupDialog : null,
    effectiveAwaiting,
    turns,
    activeSubagents,
    activeBackgroundTasks,
  });

  const pendingById = new Map<string, PendingSendItem>();
  const allTurns: AgentTurn[] = [...turns];
  for (const p of pendingSends) {
    pendingById.set(p.id, p);
    if (!turns.some((t) => t.id === p.id)) {
      allTurns.push({
        id: p.id,
        surface_id: surfaceId,
        role: "user",
        timestamp: p.createdAt,
        events: p.text ? [{ kind: "user", text: p.text }] : [],
      });
    }
  }

  const timeline: ChatTimelineItem[] = allTurns.map((turn, idx) => {
    const isLastTurn = idx === allTurns.length - 1;
    const pendingMeta = pendingById.get(turn.id);
    return buildTimelineItemForTurn({
      turn,
      isLastTurn,
      isWorking: isLastTurn && effectivelyWorking,
      activeAwaitingEventIdx: isLastTurn ? (latestAwaitingMatch?.eventIdx ?? null) : null,
      activeAwaitingRef: isLastTurn ? (latestAwaitingMatch?.awaiting ?? null) : null,
      pendingMeta,
    });
  });

  const liveActivity = selectLiveActivityLine({
    effectivelyWorking,
    isSubmitting,
    isStopping,
    activityText,
    timeline,
  });

  return {
    timeline,
    dock,
    liveActivity,
    effectivelyWorking,
    latestAwaiting: latestAwaitingMatch?.awaiting ?? null,
    effectiveAwaiting,
    needsAnswer: dock.kind !== "none",
  };
}
