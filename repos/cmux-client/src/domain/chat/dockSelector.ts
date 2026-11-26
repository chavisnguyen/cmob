import type {
  AgentEvent,
  AgentLifecycleState,
  AgentTurn,
  AwaitingInput,
  StartupDialogInfo,
} from "../../protocol/event";
import type { ComposerDockState } from "./types";

export interface LatestAwaitingMatch {
  awaiting: AwaitingInput;
  turnId: string;
  eventIdx: number;
}

export interface EffectiveAwaitingParams {
  latestAwaiting: AwaitingInput | null;
  lifecycleState?: AgentLifecycleState;
  isWorking: boolean;
  startupDialog?: StartupDialogInfo | null;
  awaitingPrompt?: string | null;
}

export function isQuestionAwaitingInput(awaiting: AwaitingInput): boolean {
  return (
    awaiting.input_kind === "question" ||
    awaiting.input_kind === "options" ||
    Boolean(awaiting.options && awaiting.options.length > 0) ||
    Boolean(awaiting.questions && awaiting.questions.length > 0)
  );
}

/**
 * Finds the active unanswered `awaiting-input` in the latest turn, if any.
 * Scans from the tail of `lastTurn.events` because agents like Antigravity append multiple
 * question-answer cycles inside a single assistant turn.
 */
export function resolveLatestAwaitingInfo(params: {
  turns: readonly AgentTurn[];
  isWorking: boolean;
  lifecycleState?: AgentLifecycleState;
}): LatestAwaitingMatch | null {
  const { turns, isWorking, lifecycleState } = params;
  if (turns.length === 0) return null;
  const lastTurn = turns[turns.length - 1];
  if (lastTurn.role === "user" || lastTurn.role === "system") return null;

  let askIndex = -1;
  for (let i = lastTurn.events.length - 1; i >= 0; i -= 1) {
    if (lastTurn.events[i].kind === "awaiting-input") {
      askIndex = i;
      break;
    }
  }
  if (askIndex === -1) return null;

  const askEv = lastTurn.events[askIndex] as Extract<AgentEvent, { kind: "awaiting-input" }>;
  if (askEv.answered && askEv.answered.trim().length > 0) {
    return null;
  }

  // If the agent continued speaking, ran tools, or finished after this prompt, it is already settled.
  const subsequentActivity = lastTurn.events
    .slice(askIndex + 1)
    .some(
      (ev) =>
        ev.kind === "done" ||
        ev.kind === "tool-start" ||
        (ev.kind === "thinking" && ev.text.trim().length > 0) ||
        ((ev.kind === "assistant" || ev.kind === "delta") && ev.text.trim().length > 0),
    );
  if (subsequentActivity) return null;

  if (isQuestionAwaitingInput(askEv)) {
    if (lifecycleState === "done" || lifecycleState === "idle") return null;
    return { awaiting: askEv, turnId: lastTurn.id, eventIdx: askIndex };
  }

  if (lifecycleState && lifecycleState !== "waiting") return null;
  if (isWorking) return null;

  return { awaiting: askEv, turnId: lastTurn.id, eventIdx: askIndex };
}

/**
 * Resolves the active approval/question prompt. Transcript-derived `latestAwaiting` takes
 * precedence; when the agent hook reports `waiting` without an `awaiting-input` transcript row
 * (as Codex does on `PermissionRequest`), synthesize a 1-tap permission prompt from `awaitingPrompt`.
 */
export function resolveEffectiveAwaiting({
  latestAwaiting,
  lifecycleState,
  isWorking,
  startupDialog,
  awaitingPrompt,
}: EffectiveAwaitingParams): AwaitingInput | null {
  if (latestAwaiting) return latestAwaiting;
  if (lifecycleState === "waiting" && !isWorking && !startupDialog) {
    return {
      input_kind: "permission",
      prompt: awaitingPrompt?.trim() || "Agent requested approval",
    };
  }
  return null;
}

export function computePromptInstanceKey(
  turnId: string,
  eventIdx: number,
  awaiting: AwaitingInput,
): string {
  const optionCount = awaiting.questions?.length
    ? awaiting.questions.reduce((acc, q) => acc + q.options.length, 0)
    : (awaiting.options?.length ?? 0);
  return `${turnId}:${eventIdx}:${awaiting.prompt}:${optionCount}`;
}

/**
 * Enforces strict mutual exclusion on `ComposerDockState`:
 * `startupDialog` > `question` wizard > `permission` approval > `none`,
 * gated on `snapshotConfirmed !== false`.
 */
export function selectComposerDock(params: {
  turns: readonly AgentTurn[];
  isWorking: boolean;
  lifecycleState?: AgentLifecycleState;
  startupDialog?: StartupDialogInfo | null;
  awaitingPrompt?: string | null;
  snapshotConfirmed?: boolean;
}): {
  dock: ComposerDockState;
  latestAwaitingMatch: LatestAwaitingMatch | null;
  effectiveAwaiting: AwaitingInput | null;
} {
  const {
    turns,
    isWorking,
    lifecycleState,
    startupDialog = null,
    awaitingPrompt = null,
    snapshotConfirmed = true,
  } = params;

  if (snapshotConfirmed === false) {
    return {
      dock: { kind: "none" },
      latestAwaitingMatch: null,
      effectiveAwaiting: null,
    };
  }

  if (startupDialog) {
    return {
      dock: { kind: "startup-dialog", dialog: startupDialog },
      latestAwaitingMatch: null,
      effectiveAwaiting: null,
    };
  }

  const latestAwaitingMatch = resolveLatestAwaitingInfo({ turns, isWorking, lifecycleState });
  const effectiveAwaiting = resolveEffectiveAwaiting({
    latestAwaiting: latestAwaitingMatch?.awaiting ?? null,
    lifecycleState,
    isWorking,
    startupDialog,
    awaitingPrompt,
  });

  if (!effectiveAwaiting) {
    return {
      dock: { kind: "none" },
      latestAwaitingMatch,
      effectiveAwaiting: null,
    };
  }

  const turnId = latestAwaitingMatch?.turnId ?? turns[turns.length - 1]?.id ?? "hook";
  const eventIdx = latestAwaitingMatch?.eventIdx ?? -1;
  const promptInstanceKey = computePromptInstanceKey(turnId, eventIdx, effectiveAwaiting);

  if (isQuestionAwaitingInput(effectiveAwaiting)) {
    return {
      dock: {
        kind: "question",
        awaiting: effectiveAwaiting,
        promptInstanceKey,
      },
      latestAwaitingMatch,
      effectiveAwaiting,
    };
  }

  return {
    dock: {
      kind: "permission",
      awaiting: effectiveAwaiting,
      promptInstanceKey,
    },
    latestAwaitingMatch,
    effectiveAwaiting,
  };
}
