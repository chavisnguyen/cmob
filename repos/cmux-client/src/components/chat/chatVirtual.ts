import {
  TURN_LIST_GAP_PX,
  estimateTimelineItemHeight,
  estimateTurnHeight,
  resolveSystemDividerLabel,
} from "../../domain/chat/heightEstimator";

export {
  TURN_LIST_GAP_PX,
  estimateTimelineItemHeight,
  estimateTurnHeight,
  resolveSystemDividerLabel,
};

export interface ProgrammaticScrollMarks {
  /** Mark a scroll element immediately before programmatic scrollTop / scrollTo writes. */
  mark: (element: Element) => void;
  /** Consume active programmatic scroll mark within `ttlMs` (returns true once per mark). */
  consume: (element: Element, now?: number) => boolean;
}

const DEFAULT_MARK_TTL_MS = 160;

/**
 * Tracks application-initiated scroll writes per element so `onScroll` handlers
 * do not mistake programmatic tail-pinning or anchor restoration for user scrolling.
 */
export function createProgrammaticScrollMarks(
  ttlMs: number = DEFAULT_MARK_TTL_MS,
): ProgrammaticScrollMarks {
  const marks = new WeakMap<Element, number>();

  return {
    mark(element: Element) {
      marks.set(element, performance.now());
    },
    consume(element: Element, now: number = performance.now()) {
      const ts = marks.get(element);
      if (ts === undefined) return false;
      marks.delete(element);
      return now - ts <= ttlMs;
    },
  };
}
