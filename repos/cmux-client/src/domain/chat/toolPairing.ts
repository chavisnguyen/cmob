import type {
  AgentEvent,
  AwaitingInput,
  BackgroundTaskEntry,
  SubagentEntry,
} from "../../protocol/event";
import type { ThoughtStepItem, ToolCallItem } from "./types";

export type NormalizedTurnStep =
  | { kind: "thinking"; thought: ThoughtStepItem; lastEventIdx: number }
  | { kind: "tool"; tool: ToolCallItem; eventIdx: number }
  | { kind: "prose"; text: string; eventIdx: number }
  | { kind: "subagents"; groupId: string; agents: SubagentEntry[]; eventIdx: number }
  | { kind: "background-tasks"; tasks: BackgroundTaskEntry[]; eventIdx: number }
  | { kind: "awaiting-input"; awaiting: AwaitingInput; eventIdx: number }
  | { kind: "status"; text: string; eventIdx: number }
  | { kind: "error"; message: string; eventIdx: number };

interface PendingProseSegment {
  firstIdx: number;
  deltas: string[];
  assistants: string[];
}

/**
 * Pre-processes a single assistant turn's raw `AgentEvent[]`:
 * 1. Pairs `tool-start` and `tool-end` across the ENTIRE turn via a FIFO queue per `tool_id`
 *    so intra-turn `thinking` / `status` events never strand a `tool-start` as stuck `live`
 *    or spawn a duplicate orphan `"Used tool"` row.
 * 2. Coalesces consecutive `delta` events and drops superseded `delta` chunks when finalized
 *    `assistant` prose is present in the same contiguous prose segment.
 * 3. Coalesces adjacent `thinking` chunks into a single thought item.
 */
export function normalizeAssistantTurnSteps(
  turnId: string,
  events: readonly AgentEvent[],
): NormalizedTurnStep[] {
  // Pass 1: Build paired ToolCallItems in FIFO order per `tool_id`.
  const openQueues = new Map<string, ToolCallItem[]>();
  const startToolByEventIdx = new Map<number, ToolCallItem>();
  const orphanToolByEventIdx = new Map<number, ToolCallItem>();

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev.kind === "tool-start") {
      const item: ToolCallItem = {
        id: ev.tool_id,
        name: ev.name,
        inputDetail: ev.detail,
        detail: ev.detail,
        isEnd: false,
      };
      startToolByEventIdx.set(i, item);
      const q = openQueues.get(ev.tool_id);
      if (q) q.push(item);
      else openQueues.set(ev.tool_id, [item]);
    } else if (ev.kind === "tool-end") {
      const q = openQueues.get(ev.tool_id);
      const matched = q && q.length > 0 ? q.shift() : undefined;
      if (matched) {
        matched.isEnd = true;
        matched.ok = ev.ok;
        if (ev.detail) matched.detail = ev.detail;
        if ((!matched.name || matched.name === "tool") && ev.name) {
          matched.name = ev.name;
        }
      } else {
        orphanToolByEventIdx.set(i, {
          id: ev.tool_id,
          name: ev.name || "tool",
          detail: ev.detail,
          ok: ev.ok,
          isEnd: true,
        });
      }
    }
  }

  // Pass 2: Coalesce prose (`delta` vs `assistant`) and adjacent `thinking` chunks.
  const steps: NormalizedTurnStep[] = [];
  let proseSeg: PendingProseSegment | null = null;
  let lastStepIsAdjacentThinking = false;

  const flushProse = () => {
    if (!proseSeg) return;
    const seg = proseSeg;
    proseSeg = null;
    lastStepIsAdjacentThinking = false;

    if (seg.assistants.length > 0) {
      // Finalized `assistant` prose supersedes `delta` chunks in the same segment.
      const combined = seg.assistants.join("\n\n").trim();
      if (combined) {
        steps.push({ kind: "prose", text: combined, eventIdx: seg.firstIdx });
      }
    } else if (seg.deltas.length > 0) {
      const streamed = seg.deltas.join("").trim();
      if (streamed) {
        steps.push({ kind: "prose", text: streamed, eventIdx: seg.firstIdx });
      }
    }
  };

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];

    if (ev.kind === "usage" || ev.kind === "done" || ev.kind === "user") {
      continue;
    }

    if (ev.kind === "delta") {
      if (!ev.text) continue;
      lastStepIsAdjacentThinking = false;
      if (!proseSeg) {
        proseSeg = { firstIdx: i, deltas: [ev.text], assistants: [] };
      } else {
        proseSeg.deltas.push(ev.text);
      }
      continue;
    }

    if (ev.kind === "assistant") {
      const trimmed = ev.text?.trim() ?? "";
      if (!trimmed) continue;
      lastStepIsAdjacentThinking = false;
      if (!proseSeg) {
        proseSeg = { firstIdx: i, deltas: [], assistants: [trimmed] };
      } else {
        proseSeg.assistants.push(trimmed);
      }
      continue;
    }

    if (ev.kind === "tool-start") {
      flushProse();
      lastStepIsAdjacentThinking = false;
      const tool = startToolByEventIdx.get(i);
      if (tool) {
        steps.push({ kind: "tool", tool, eventIdx: i });
      }
      continue;
    }

    if (ev.kind === "tool-end") {
      lastStepIsAdjacentThinking = false;
      const orphan = orphanToolByEventIdx.get(i);
      if (orphan) {
        flushProse();
        steps.push({ kind: "tool", tool: orphan, eventIdx: i });
      }
      continue;
    }

    if (ev.kind === "thinking") {
      const trimmed = ev.text?.trim() ?? "";
      if (!trimmed) continue;
      flushProse();
      const prev = steps[steps.length - 1];
      if (lastStepIsAdjacentThinking && prev && prev.kind === "thinking") {
        const nextDur =
          prev.thought.durationSeconds !== undefined || ev.duration_secs !== undefined
            ? (prev.thought.durationSeconds ?? 0) + (ev.duration_secs ?? 0)
            : undefined;
        prev.thought = {
          id: prev.thought.id,
          text: `${prev.thought.text}\n\n${trimmed}`,
          ...(nextDur !== undefined && nextDur > 0 ? { durationSeconds: nextDur } : {}),
        };
        prev.lastEventIdx = i;
      } else {
        steps.push({
          kind: "thinking",
          thought: {
            id: `${turnId}:reasoning-${i}`,
            text: trimmed,
            durationSeconds: ev.duration_secs,
          },
          lastEventIdx: i,
        });
      }
      lastStepIsAdjacentThinking = true;
      continue;
    }

    flushProse();
    lastStepIsAdjacentThinking = false;

    switch (ev.kind) {
      case "subagents":
        steps.push({ kind: "subagents", groupId: ev.group_id, agents: ev.agents, eventIdx: i });
        break;
      case "background-tasks":
        steps.push({ kind: "background-tasks", tasks: ev.tasks, eventIdx: i });
        break;
      case "awaiting-input":
        steps.push({ kind: "awaiting-input", awaiting: ev, eventIdx: i });
        break;
      case "status":
        if (ev.text.trim()) {
          steps.push({ kind: "status", text: ev.text, eventIdx: i });
        }
        break;
      case "error":
        steps.push({ kind: "error", message: ev.message, eventIdx: i });
        break;
    }
  }

  flushProse();
  return steps;
}
