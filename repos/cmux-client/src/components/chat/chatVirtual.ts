import type { AgentTurn } from "../../protocol/event";

export const TURN_LIST_GAP_PX = 8;

const MIN_TURN_HEIGHT_PX = 44;
const MAX_PROSE_ESTIMATE_PX = 900;
const PROSE_CHARS_PER_LINE = 64;
const PROSE_LINE_HEIGHT_PX = 21;
const USER_CHARS_PER_LINE = 52;
const USER_COLLAPSED_CAP_PX = 140;

function estimateWrappedLines(text: string, charsPerLine: number): number {
  if (!text) return 0;
  let lines = 1;
  let col = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      col = 0;
    } else {
      col += 1;
      if (col >= charsPerLine) {
        lines += 1;
        col = 0;
      }
    }
  }
  return lines;
}

/**
 * Estimate initial rendered height of an `AgentTurn` before DOM measurement.
 * Close initial estimates reduce initial scroll-anchoring correction passes
 * when mounting or prepending history in `OrcaChatView`.
 */
export function estimateTurnHeight(turn: AgentTurn): number {
  if (turn.role === "user") {
    let totalLines = 0;
    for (const ev of turn.events) {
      if (ev.kind === "user") {
        totalLines += estimateWrappedLines(ev.text.trim(), USER_CHARS_PER_LINE);
      }
    }
    const contentHeight = Math.min(USER_COLLAPSED_CAP_PX, Math.max(1, totalLines) * 20);
    return Math.max(MIN_TURN_HEIGHT_PX, contentHeight + 24);
  }

  let height = 8;
  let toolRunCount = 0;
  let inToolRun = false;

  const flushTools = () => {
    if (!inToolRun) return;
    height += 36 + Math.min(toolRunCount, 6) * 22 + 6;
    toolRunCount = 0;
    inToolRun = false;
  };

  for (const ev of turn.events) {
    if (ev.kind === "tool-start") {
      inToolRun = true;
      toolRunCount += 1;
      continue;
    }
    if (ev.kind === "tool-end") {
      inToolRun = true;
      if (toolRunCount === 0) toolRunCount = 1;
      continue;
    }
    if (ev.kind === "usage" || ev.kind === "done") continue;
    if (ev.kind === "thinking" && !ev.text.trim()) continue;
    if ((ev.kind === "assistant" || ev.kind === "delta") && !ev.text.trim()) continue;

    flushTools();

    switch (ev.kind) {
      case "thinking":
        height += 40;
        break;
      case "subagents":
        height += 44 + ev.agents.length * 24;
        break;
      case "awaiting-input":
        height += 116;
        break;
      case "assistant":
      case "delta": {
        const lines = estimateWrappedLines(ev.text, PROSE_CHARS_PER_LINE);
        height += Math.min(MAX_PROSE_ESTIMATE_PX, Math.max(1, lines) * PROSE_LINE_HEIGHT_PX + 12);
        break;
      }
      case "status":
        height += 24;
        break;
      case "error":
        height += 56;
        break;
      default:
        height += 32;
        break;
    }
  }

  flushTools();
  return Math.max(MIN_TURN_HEIGHT_PX, height);
}

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
