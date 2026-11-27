import type { AgentTurn } from "../../protocol/event";
import { getDisclosureState } from "./disclosureStore";
import type { ChatTimelineItem } from "./types";

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

const COMPACT_CONTINUATION_RE = /^\s*This session is being continued from a previous conversation/i;

/**
 * Returns the centered divider label when `turn` is a system boundary (or a cached
 * pre-v0.1.14 Claude auto-compaction user record), else `null`.
 */
export function resolveSystemDividerLabel(turn: AgentTurn): string | null {
  if (turn.role === "system") {
    for (const ev of turn.events) {
      if (ev.kind === "status" && ev.text.trim()) return ev.text.trim();
      if ((ev.kind === "user" || ev.kind === "assistant") && ev.text.trim()) return ev.text.trim();
    }
    return "Context compacted";
  }
  if (turn.role === "user" && turn.events.length > 0) {
    const userEvents = turn.events.filter((ev) => ev.kind === "user");
    if (
      userEvents.length > 0 &&
      userEvents.every((ev) => ev.kind === "user" && COMPACT_CONTINUATION_RE.test(ev.text))
    ) {
      return "Context compacted";
    }
  }
  return null;
}

/**
 * Disclosure-aware height estimator for normalized `ChatTimelineItem`s.
 */
export function estimateTimelineItemHeight(item: ChatTimelineItem, surfaceKey?: string): number {
  if (item.kind === "divider") {
    return 36;
  }
  if (item.kind === "user") {
    let totalLines = 0;
    let expandedAny = false;
    for (let i = 0; i < item.texts.length; i += 1) {
      totalLines += estimateWrappedLines(item.texts[i], USER_CHARS_PER_LINE);
      if (getDisclosureState(surfaceKey, `collapse:${item.id}:u-${i}`, false)) {
        expandedAny = true;
      }
    }
    const rawHeight = Math.max(1, totalLines) * 20;
    const textHeight = expandedAny ? rawHeight : Math.min(USER_COLLAPSED_CAP_PX, rawHeight);
    const imgHeight = item.imagePreviews.length + item.images.length > 0 ? 76 : 0;
    return Math.max(MIN_TURN_HEIGHT_PX, textHeight + imgHeight + 24);
  }

  let height = 8;
  for (const block of item.blocks) {
    switch (block.kind) {
      case "work-run": {
        const open = getDisclosureState(surfaceKey, `workrun:${block.key}`, false);
        height += open ? 36 + Math.min(block.steps.length, 10) * 32 + 12 : 34;
        break;
      }
      case "live-reasoning": {
        const open = getDisclosureState(surfaceKey, `reasoning:${block.id}`, false);
        const lines = open ? estimateWrappedLines(block.text, PROSE_CHARS_PER_LINE) : 0;
        height += open ? 34 + Math.min(240, lines * 18 + 12) : 34;
        break;
      }
      case "prose": {
        const lines = estimateWrappedLines(block.text, PROSE_CHARS_PER_LINE);
        height += Math.min(MAX_PROSE_ESTIMATE_PX, Math.max(1, lines) * PROSE_LINE_HEIGHT_PX + 12);
        break;
      }
      case "subagents": {
        const open = getDisclosureState(surfaceKey, `subagents:${block.groupId}`, false);
        height += open ? 44 + block.agents.length * 42 : 44;
        break;
      }
      case "background-tasks": {
        const open = getDisclosureState(surfaceKey, `bgtasks:${block.key}`, false);
        height += open ? 44 + block.tasks.length * 46 : 44;
        break;
      }
      case "awaiting-input":
        height += 96;
        break;
      case "status":
        height += 24;
        break;
      case "error":
        height += 56;
        break;
    }
  }
  return Math.max(MIN_TURN_HEIGHT_PX, height);
}

/**
 * Estimate initial rendered height of an `AgentTurn` before DOM measurement.
 */
export function estimateTurnHeight(turn: AgentTurn, surfaceKey?: string): number {
  if (resolveSystemDividerLabel(turn) !== null) {
    return 36;
  }
  if (turn.role === "user") {
    let totalLines = 0;
    let expandedAny = false;
    for (let i = 0; i < turn.events.length; i += 1) {
      const ev = turn.events[i];
      if (ev.kind === "user") {
        totalLines += estimateWrappedLines(ev.text.trim(), USER_CHARS_PER_LINE);
        if (getDisclosureState(surfaceKey, `collapse:${turn.id}:u-${i}`, false)) {
          expandedAny = true;
        }
      }
    }
    const rawHeight = Math.max(1, totalLines) * 20;
    const contentHeight = expandedAny ? rawHeight : Math.min(USER_COLLAPSED_CAP_PX, rawHeight);
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
      case "background-tasks":
        height += 44;
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
