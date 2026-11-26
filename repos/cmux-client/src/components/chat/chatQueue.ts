import type { AgentLifecycleState } from "../../protocol/event";
import {
  resolveEffectiveAwaiting,
  type EffectiveAwaitingParams,
} from "../../domain/chat/dockSelector";
import type { QueuedMessage } from "../../domain/chat/types";

export { resolveEffectiveAwaiting };
export type { EffectiveAwaitingParams, QueuedMessage };

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
  lifecycle: string | undefined;
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
