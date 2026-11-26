import type { AgentEvent, AgentTurn } from "../../protocol/event";
import type { WireSessionFrame } from "./types";

function hashStringFnv1a(hash: number, str: string): number {
  let h = hash;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Computes a structural digest of an `AgentTurn` covering role, truncation flag, event count,
 * text lengths & content hash, tool states/ok/details, subagent/task states, `answered`, and
 * `duration_secs` so in-place updates are never dropped by reference reuse.
 */
export function computeTurnDigest(turn: AgentTurn): string {
  let h = 0x811c9dc5;
  h = hashStringFnv1a(h, `${turn.role}:${turn.truncated ? 1 : 0}:${turn.events.length}`);

  for (let i = 0; i < turn.events.length; i += 1) {
    const ev = turn.events[i];
    h = hashStringFnv1a(h, `|${ev.kind}:`);
    switch (ev.kind) {
      case "user":
      case "assistant":
      case "delta":
      case "status":
        h = hashStringFnv1a(h, `${ev.text.length}:${ev.text}`);
        break;
      case "thinking":
        h = hashStringFnv1a(h, `${ev.duration_secs ?? -1}:${ev.text.length}:${ev.text}`);
        break;
      case "tool-start":
        h = hashStringFnv1a(h, `${ev.tool_id}:${ev.name}:${ev.detail ?? ""}`);
        break;
      case "tool-end":
        h = hashStringFnv1a(h, `${ev.tool_id}:${ev.name ?? ""}:${ev.ok ?? "u"}:${ev.detail ?? ""}`);
        break;
      case "subagents":
        h = hashStringFnv1a(h, `${ev.group_id}:${ev.agents.length}`);
        for (const a of ev.agents) {
          h = hashStringFnv1a(
            h,
            `,${a.id}:${a.label}:${a.state}:${a.tokens ?? 0}:${a.started_at ?? 0}:${a.settled_at ?? 0}`,
          );
        }
        break;
      case "background-tasks":
        h = hashStringFnv1a(h, `${ev.tasks.length}`);
        for (const t of ev.tasks) {
          h = hashStringFnv1a(
            h,
            `,${t.id}:${t.kind}:${t.label}:${t.state}:${t.tokens ?? 0}:${t.started_at ?? 0}:${t.settled_at ?? 0}:${t.summary ?? ""}`,
          );
        }
        break;
      case "awaiting-input":
        h = hashStringFnv1a(
          h,
          `${ev.input_kind}:${ev.prompt}:${ev.answered ?? ""}:${ev.multi_select ? 1 : 0}:${(ev.options ?? []).join("\u0001")}:${(ev.questions ?? []).map((q) => `${q.question}:${q.options.join(",")}`).join("\u0002")}`,
        );
        break;
      case "done":
        h = hashStringFnv1a(h, ev.stats ?? "");
        break;
      case "usage":
        h = hashStringFnv1a(
          h,
          `${ev.model ?? ""}:${ev.input_tokens}:${ev.output_tokens}:${ev.cache_read_tokens ?? 0}:${ev.cache_creation_tokens ?? 0}`,
        );
        break;
      case "error":
        h = hashStringFnv1a(h, ev.message);
        break;
    }
  }

  const tail = turn.events[turn.events.length - 1];
  return `${turn.role}:${turn.truncated ? "T" : "F"}:${turn.events.length}:${tail?.kind ?? "none"}:${h.toString(16)}`;
}

function eventsEqual(a: AgentEvent, b: AgentEvent): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "user":
    case "assistant":
    case "delta":
    case "status":
      return a.text === (b as typeof a).text;
    case "thinking": {
      const bt = b as typeof a;
      return a.duration_secs === bt.duration_secs && a.text === bt.text;
    }
    case "tool-start": {
      const bt = b as typeof a;
      return a.tool_id === bt.tool_id && a.name === bt.name && a.detail === bt.detail;
    }
    case "tool-end": {
      const bt = b as typeof a;
      return (
        a.tool_id === bt.tool_id && a.name === bt.name && a.ok === bt.ok && a.detail === bt.detail
      );
    }
    case "subagents": {
      const bs = b as typeof a;
      if (a.group_id !== bs.group_id || a.agents.length !== bs.agents.length) return false;
      for (let i = 0; i < a.agents.length; i += 1) {
        const x = a.agents[i];
        const y = bs.agents[i];
        if (
          x.id !== y.id ||
          x.label !== y.label ||
          x.state !== y.state ||
          x.tokens !== y.tokens ||
          x.started_at !== y.started_at ||
          x.settled_at !== y.settled_at
        ) {
          return false;
        }
      }
      return true;
    }
    case "background-tasks": {
      const bb = b as typeof a;
      if (a.tasks.length !== bb.tasks.length) return false;
      for (let i = 0; i < a.tasks.length; i += 1) {
        const x = a.tasks[i];
        const y = bb.tasks[i];
        if (
          x.id !== y.id ||
          x.kind !== y.kind ||
          x.label !== y.label ||
          x.state !== y.state ||
          x.summary !== y.summary ||
          x.tokens !== y.tokens ||
          x.started_at !== y.started_at ||
          x.settled_at !== y.settled_at
        ) {
          return false;
        }
      }
      return true;
    }
    case "awaiting-input": {
      const ba = b as typeof a;
      if (
        a.input_kind !== ba.input_kind ||
        a.prompt !== ba.prompt ||
        a.answered !== ba.answered ||
        a.multi_select !== ba.multi_select ||
        a.default_choice !== ba.default_choice
      ) {
        return false;
      }
      const ao = a.options ?? [];
      const bo = ba.options ?? [];
      if (ao.length !== bo.length || ao.some((v, idx) => v !== bo[idx])) return false;
      const aq = a.questions ?? [];
      const bq = ba.questions ?? [];
      if (aq.length !== bq.length) return false;
      for (let i = 0; i < aq.length; i += 1) {
        if (
          aq[i].question !== bq[i].question ||
          aq[i].multi_select !== bq[i].multi_select ||
          aq[i].options.length !== bq[i].options.length ||
          aq[i].options.some((v, idx) => v !== bq[i].options[idx])
        ) {
          return false;
        }
      }
      return true;
    }
    case "done":
      return a.stats === (b as typeof a).stats;
    case "usage": {
      const bu = b as typeof a;
      return (
        a.model === bu.model &&
        a.input_tokens === bu.input_tokens &&
        a.output_tokens === bu.output_tokens &&
        a.cache_read_tokens === bu.cache_read_tokens &&
        a.cache_creation_tokens === bu.cache_creation_tokens
      );
    }
    case "error":
      return a.message === (b as typeof a).message;
  }
}

export function turnsStructurallyEqual(oldTurn: AgentTurn, nextTurn: AgentTurn): boolean {
  if (oldTurn.truncated && !nextTurn.truncated) return false;
  if (oldTurn.id !== nextTurn.id || oldTurn.role !== nextTurn.role) return false;
  if (oldTurn.events.length !== nextTurn.events.length) return false;
  if (computeTurnDigest(oldTurn) !== computeTurnDigest(nextTurn)) return false;
  for (let i = 0; i < oldTurn.events.length; i += 1) {
    if (!eventsEqual(oldTurn.events[i], nextTurn.events[i])) return false;
  }
  return true;
}

/**
 * Orca `replayRetainedTailStart` contiguous ID sequence check:
 * Verifies that `incoming` starts at `overlapStart > 0` inside `prevTurns` AND that every
 * remaining turn in `prevTurns.slice(overlapStart)` matches `incoming[0 .. sharedCount - 1]`
 * in exact contiguous ID order so sliding/renumbered IDs never splice at a wrong historical turn.
 */
export function replayRetainedTailStart(
  prevTurns: readonly AgentTurn[],
  incoming: readonly AgentTurn[],
): number | null {
  if (prevTurns.length === 0 || incoming.length === 0) return null;
  const firstIncomingId = incoming[0].id;
  if (!firstIncomingId) return null;

  let overlapStart = -1;
  for (let i = prevTurns.length - 1; i >= 0; i -= 1) {
    if (prevTurns[i].id === firstIncomingId) {
      overlapStart = i;
      break;
    }
  }
  if (overlapStart <= 0) return null;

  const sharedCount = prevTurns.length - overlapStart;
  if (incoming.length < sharedCount) return null;

  for (let k = 0; k < sharedCount; k += 1) {
    if (prevTurns[overlapStart + k]?.id !== incoming[k]?.id) {
      return null;
    }
  }
  return overlapStart;
}

function isValidDeltaAnchor(
  prevTurns: readonly AgentTurn[],
  anchorIdx: number,
  tailTurns: readonly AgentTurn[],
): boolean {
  if (anchorIdx < 0 || anchorIdx >= prevTurns.length) return false;
  const existingAfterAnchor = prevTurns.length - 1 - anchorIdx;
  if (existingAfterAnchor === 0) return true;
  if (tailTurns.length < existingAfterAnchor) return false;
  for (let k = 0; k < existingAfterAnchor; k += 1) {
    if (prevTurns[anchorIdx + 1 + k]?.id !== tailTurns[k]?.id) {
      return false;
    }
  }
  return true;
}

export function mergeIncomingSessionFrame(args: {
  prevTurns: AgentTurn[];
  frame: WireSessionFrame;
  replaceSnapshot: boolean;
  maxRetained: number;
}): {
  turns: AgentTurn[];
  windowReplaced: boolean;
  cursorInvalidated: boolean;
  hasMore?: boolean;
  beforeOffset?: number | null;
} | null {
  const { prevTurns, frame, replaceSnapshot, maxRetained } = args;

  const prevById = new Map<string, AgentTurn>();
  for (let i = 0; i < prevTurns.length; i += 1) {
    prevById.set(prevTurns[i].id, prevTurns[i]);
  }

  const reuseTurnRefs = (list: AgentTurn[]): AgentTurn[] =>
    list.map((nextTurn) => {
      const oldTurn = prevById.get(nextTurn.id);
      return oldTurn && turnsStructurallyEqual(oldTurn, nextTurn) ? oldTurn : nextTurn;
    });

  if (
    frame.update_kind === "delta" &&
    typeof frame.after_turn_id === "string" &&
    Array.isArray(frame.tail_turns)
  ) {
    let anchorIdx = -1;
    for (let i = prevTurns.length - 1; i >= 0; i -= 1) {
      if (prevTurns[i]?.id === frame.after_turn_id) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx !== -1 && isValidDeltaAnchor(prevTurns, anchorIdx, frame.tail_turns)) {
      const prevFirstId = prevTurns[0]?.id;
      let merged = [...prevTurns.slice(0, anchorIdx + 1), ...reuseTurnRefs(frame.tail_turns)];
      if (maxRetained > 0 && merged.length > maxRetained) {
        merged = merged.slice(merged.length - maxRetained);
      }
      const cursorInvalidated = Boolean(prevFirstId && merged[0]?.id !== prevFirstId);
      return {
        turns: merged,
        windowReplaced: false,
        cursorInvalidated,
        ...(cursorInvalidated ? { hasMore: true, beforeOffset: null } : {}),
      };
    }
  }

  if (!Array.isArray(frame.turns)) return null;

  const incoming = frame.turns;
  if (prevTurns.length === 0 && incoming.length === 0) {
    return {
      turns: prevTurns,
      windowReplaced: true,
      cursorInvalidated: false,
      hasMore: frame.has_more ?? false,
      beforeOffset: frame.before_offset ?? null,
    };
  }

  if (!replaceSnapshot && prevTurns.length > 0 && incoming.length > 0 && frame.has_more !== false) {
    const overlapStart = replayRetainedTailStart(prevTurns, incoming);
    if (overlapStart !== null) {
      const prefix = prevTurns.slice(0, overlapStart);
      let combined = [...prefix, ...reuseTurnRefs(incoming)];
      const prevFirstId = prevTurns[0]?.id;
      if (maxRetained > 0 && combined.length > maxRetained) {
        combined = combined.slice(combined.length - maxRetained);
      }
      const cursorInvalidated = Boolean(prevFirstId && combined[0]?.id !== prevFirstId);
      return {
        turns: combined,
        windowReplaced: false,
        cursorInvalidated,
        ...(cursorInvalidated ? { hasMore: true, beforeOffset: null } : {}),
      };
    }
  }

  const reused = prevTurns.length > 0 ? reuseTurnRefs(incoming) : incoming;
  const allSame = reused.length === prevTurns.length && reused.every((t, i) => t === prevTurns[i]);
  return {
    turns: allSame ? prevTurns : reused,
    windowReplaced: true,
    cursorInvalidated: false,
    hasMore: frame.has_more,
    beforeOffset: frame.before_offset ?? null,
  };
}

export function prependOlderTurns(olderTurns: AgentTurn[], currentTurns: AgentTurn[]): AgentTurn[] {
  if (olderTurns.length === 0) return currentTurns;
  const olderIds = new Set(olderTurns.map((t) => t.id));
  const tail = currentTurns.filter((t) => !olderIds.has(t.id));
  return [...olderTurns, ...tail];
}
