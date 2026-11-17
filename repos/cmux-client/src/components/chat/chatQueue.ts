import type { AgentLifecycleState, AwaitingInput, StartupDialogInfo } from "../../protocol/event";

/**
 * Client-side queue of messages typed while the agent is busy.
 *
 * Orca keeps a host-side queue (agentSession.queuedMessage* RPCs); the gateway has no such API, so this
 * queue lives in the browser: messages wait here and are sent one at a time once the agent is idle.
 * Nothing is sent while the agent is waiting for approval/input, because a queued line would be typed
 * into a permission prompt.
 */

export interface QueuedMessage {
  id: string;
  text: string;
  /** Paths of images already uploaded to the host, pasted before the text when it is sent. */
  images: string[];
}

/** Adds a message; a message needs text or at least one image. */
export function enqueue(
  queue: readonly QueuedMessage[],
  text: string,
  id: string,
  images: readonly string[] = [],
): QueuedMessage[] {
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) return [...queue];
  return [...queue, { id, text: trimmed, images: [...images] }];
}

export function removeQueued(queue: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((m) => m.id !== id);
}

export interface DrainState {
  queueLength: number;
  isWorking: boolean;
  isSubmitting: boolean;
  /** Agent lifecycle reported by the gateway. */
  lifecycle: string | undefined;
  /** A permission/question card or a startup dialog is showing. */
  needsAnswer: boolean;
}

/** True when the head of the queue may be sent now. */
export function canDrain(s: DrainState): boolean {
  if (s.queueLength === 0) return false;
  if (s.isWorking || s.isSubmitting || s.needsAnswer) return false;
  if (s.lifecycle === "waiting" || s.lifecycle === "working") return false;
  return true;
}

/** How long the agent must stay idle before the next queued message goes out. */
export const DRAIN_SETTLE_MS = 1500;

export interface EffectiveAwaitingParams {
  latestAwaiting: AwaitingInput | null;
  lifecycleState?: AgentLifecycleState;
  isWorking: boolean;
  startupDialog?: StartupDialogInfo | null;
  awaitingPrompt?: string | null;
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

export function queueStatusLabel(params: {
  index: number;
  queuePaused: boolean;
  lifecycleState?: AgentLifecycleState;
  needsAnswer: boolean;
}): string {
  if (params.queuePaused && params.index === 0) return "Paused";
  if (params.lifecycleState === "waiting" || params.needsAnswer) return "Waiting for approval";
  return "Queued";
}
