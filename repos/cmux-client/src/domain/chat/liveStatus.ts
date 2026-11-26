import type { AgentTurn, AwaitingInput, StartupDialogInfo } from "../../protocol/event";
import type { ChatTimelineItem, LiveActivityLineState } from "./types";

function hasWorkingChildWork(turns: readonly AgentTurn[]): boolean {
  const stateByKey = new Map<string, string>();
  for (const turn of turns) {
    for (const ev of turn.events) {
      if (ev.kind === "subagents") {
        for (const a of ev.agents) {
          stateByKey.set(`agent:${a.id}`, a.state);
        }
      } else if (ev.kind === "background-tasks") {
        for (const t of ev.tasks) {
          stateByKey.set(`bg:${t.id}`, t.state);
        }
      }
    }
  }
  for (const st of stateByKey.values()) {
    if (st === "working") return true;
  }
  return false;
}

function lastTurnEndedWithDone(turns: readonly AgentTurn[]): boolean {
  if (turns.length === 0) return false;
  const lastTurn = turns[turns.length - 1];
  if (lastTurn.role !== "assistant") return false;
  for (let i = lastTurn.events.length - 1; i >= 0; i -= 1) {
    const ev = lastTurn.events[i];
    if (ev.kind === "usage") continue;
    return ev.kind === "done";
  }
  return false;
}

/**
 * Reconciles whether the session is actively working:
 * - False when blocked on `startupDialog` or `effectiveAwaiting`
 * - True during `withinGrace` (fresh optimistic user send awaiting transcript echo)
 * - False when `snapshotConfirmed === false` (unconfirmed cached snapshot)
 * - False when the latest assistant turn ends with a settled `done` event and no subagents/tasks
 *   are still `"working"`
 */
export function computeEffectivelyWorking(params: {
  isWorking: boolean;
  withinGrace?: boolean;
  snapshotConfirmed?: boolean;
  startupDialog?: StartupDialogInfo | null;
  effectiveAwaiting?: AwaitingInput | null;
  turns: readonly AgentTurn[];
}): boolean {
  const {
    isWorking,
    withinGrace = false,
    snapshotConfirmed = true,
    startupDialog = null,
    effectiveAwaiting = null,
    turns,
  } = params;

  if (startupDialog || effectiveAwaiting) return false;
  if (withinGrace) return true;
  if (!snapshotConfirmed || !isWorking) return false;
  if (lastTurnEndedWithDone(turns) && !hasWorkingChildWork(turns)) {
    return false;
  }
  return true;
}

function tailHasInlineLiveIndicator(timeline: readonly ChatTimelineItem[]): boolean {
  if (timeline.length === 0) return false;
  const last = timeline[timeline.length - 1];
  if (last.kind !== "assistant" || last.blocks.length === 0) return false;
  const tailBlock = last.blocks[last.blocks.length - 1];
  if (tailBlock.kind === "live-reasoning" && tailBlock.live) return true;
  if (tailBlock.kind === "work-run" && tailBlock.live) return true;
  return false;
}

/**
 * Computes `LiveActivityLineState` (`visible`, `activityText`, `stopping`), suppressing the
 * redundant bottom `Thinking…` spinner whenever the tail block is already an inline pulsing
 * `live` Reasoning or WorkRun row (unless `isStopping` is true).
 */
export function selectLiveActivityLine(params: {
  effectivelyWorking: boolean;
  isSubmitting: boolean;
  isStopping: boolean;
  activityText: string | null;
  timeline: readonly ChatTimelineItem[];
}): LiveActivityLineState {
  const { effectivelyWorking, isSubmitting, isStopping, activityText, timeline } = params;

  if (isStopping && (effectivelyWorking || isSubmitting)) {
    return {
      visible: true,
      activityText: "Stopping…",
      stopping: true,
    };
  }

  if (!effectivelyWorking && !isSubmitting) {
    return {
      visible: false,
      activityText: null,
      stopping: false,
    };
  }

  if (!isSubmitting && tailHasInlineLiveIndicator(timeline)) {
    return {
      visible: false,
      activityText: null,
      stopping: false,
    };
  }

  return {
    visible: true,
    activityText: activityText || "Thinking…",
    stopping: false,
  };
}
