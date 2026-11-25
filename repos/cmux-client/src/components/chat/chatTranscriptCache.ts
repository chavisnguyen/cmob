import type { AgentLifecycleState, AgentTurn, StartupDialogInfo } from "../../protocol/event";

export interface WireSessionFrame {
  update_kind?: "snapshot" | "delta";
  turns?: AgentTurn[];
  after_turn_id?: string;
  tail_turns?: AgentTurn[];
  agent_kind?: string;
  session_id?: string;
  is_working?: boolean;
  lifecycle_state?: AgentLifecycleState;
  last_event?: string;
  last_subtitle?: string;
  awaiting_prompt?: string | null;
  activity?: string | null;
  surface_id?: string;
  startup_dialog?: StartupDialogInfo | null;
  has_more?: boolean;
  before_offset?: number | null;
  total_turns?: number;
}

export interface CachedChatTranscript {
  turns: AgentTurn[];
  hasMore: boolean;
  beforeOffset: number | null;
  lifecycleState: AgentLifecycleState;
  isWorking: boolean;
  activityText: string | null;
  savedAt: number;
}

const STORED_VERSION = 1;
const STORAGE_KEY = "cmux.chat.transcriptCache.v1";
const MAX_MEMORY_ENTRIES = 12;
const MAX_PERSISTED_ENTRIES = 8;
const MAX_PERSISTED_TURNS = 30;
const MAX_PERSISTED_TEXT_CHARS = 8_000;

const memoryCache = new Map<string, CachedChatTranscript>();
let hydratedFromStorage = false;

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    if (typeof window.localStorage.getItem !== "function") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function hydrateStorageOnce(): void {
  if (hydratedFromStorage) return;
  hydratedFromStorage = true;
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      v?: number;
      entries?: [string, CachedChatTranscript][];
    };
    if (parsed?.v !== STORED_VERSION || !Array.isArray(parsed.entries)) return;
    for (const [key, value] of parsed.entries) {
      if (typeof key === "string" && value && Array.isArray(value.turns) && !memoryCache.has(key)) {
        memoryCache.set(key, value);
      }
    }
  } catch {
    // Ignore malformed or unavailable storage.
  }
}

function trimTurnForStorage(turn: AgentTurn): AgentTurn {
  let mutated = false;
  const events = turn.events.map((ev) => {
    if (
      (ev.kind === "assistant" ||
        ev.kind === "delta" ||
        ev.kind === "thinking" ||
        ev.kind === "user") &&
      ev.text.length > MAX_PERSISTED_TEXT_CHARS
    ) {
      mutated = true;
      return { ...ev, text: `${ev.text.slice(0, MAX_PERSISTED_TEXT_CHARS)}…` };
    }
    return ev;
  });
  return mutated ? { ...turn, events } : turn;
}

function persistMemoryCache(): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    const all = Array.from(memoryCache.entries());
    const recent = all.slice(Math.max(0, all.length - MAX_PERSISTED_ENTRIES)).map(([k, v]) => {
      const sliced =
        v.turns.length > MAX_PERSISTED_TURNS
          ? v.turns.slice(v.turns.length - MAX_PERSISTED_TURNS)
          : v.turns;
      const trimmedSelected = sliced.length < v.turns.length;
      const persisted: CachedChatTranscript = {
        ...v,
        turns: sliced.map(trimTurnForStorage),
        hasMore: v.hasMore || trimmedSelected,
        // Trimming older turns from the persisted copy invalidates the earlier byte cursor.
        beforeOffset: trimmedSelected ? null : v.beforeOffset,
      };
      return [k, persisted] as const;
    });
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: STORED_VERSION, entries: recent }));
  } catch {
    // Quota or private-mode failures are non-fatal; Tier-1 memory cache remains active.
  }
}

export function buildTranscriptCacheKey(args: {
  endpoint: string | null | undefined;
  surfaceKey: string;
  agentKind?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
}): string {
  const host = args.endpoint || "local";
  const agent = args.agentKind || "agent";
  const sid = args.sessionId || "";
  const path = args.transcriptPath || "";
  return `${host}|${args.surfaceKey}|${agent}|${sid}|${path}`;
}

export function peekCachedChatTranscript(identity: string): CachedChatTranscript | null {
  hydrateStorageOnce();
  const hit = memoryCache.get(identity);
  if (!hit) return null;
  // Refresh LRU order.
  memoryCache.delete(identity);
  memoryCache.set(identity, hit);
  return hit;
}

export function writeCachedChatTranscript(
  identity: string,
  entry: CachedChatTranscript,
  persistToDisk: boolean = true,
): void {
  hydrateStorageOnce();
  memoryCache.delete(identity);
  memoryCache.set(identity, entry);
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
  if (persistToDisk) {
    persistMemoryCache();
  }
}

export function clearChatTranscriptCacheForTests(): void {
  memoryCache.clear();
  hydratedFromStorage = true;
  safeLocalStorage()?.removeItem(STORAGE_KEY);
}

/**
 * Merge an incoming `snapshot` or `delta` frame into the retained turn list in O(k)
 * without stringifying historical turns (Orca `applyMobileNativeChatStreamFrame` pattern).
 */
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

  // 1. Incremental delta frame (`update_kind: "delta"`): splice after `after_turn_id` in O(1).
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
    if (anchorIdx !== -1) {
      const prevFirstId = prevTurns[0]?.id;
      let merged = [...prevTurns.slice(0, anchorIdx + 1), ...frame.tail_turns];
      if (merged.length > maxRetained) {
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

  if (!Array.isArray(frame.turns)) {
    return null;
  }

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

  const prevById = new Map<string, AgentTurn>();
  const prevIndexById = new Map<string, number>();
  for (let i = 0; i < prevTurns.length; i += 1) {
    const t = prevTurns[i];
    prevById.set(t.id, t);
    prevIndexById.set(t.id, i);
  }

  const reuseTurnRefs = (list: AgentTurn[]): AgentTurn[] =>
    list.map((nextTurn, idx) => {
      const oldTurn = prevById.get(nextTurn.id);
      if (
        oldTurn &&
        idx < list.length - 1 &&
        oldTurn.role === nextTurn.role &&
        oldTurn.events.length === nextTurn.events.length
      ) {
        return oldTurn;
      }
      return nextTurn;
    });

  // 2. Reconnect replay preservation: if the reader already loaded older pages (`!replaceSnapshot`)
  // and the new tail snapshot cleanly overlaps the end of `prevTurns`, retain the older prefix.
  if (!replaceSnapshot && prevTurns.length > 0 && incoming.length > 0) {
    const overlapStart = prevIndexById.get(incoming[0].id);
    if (
      overlapStart !== undefined &&
      overlapStart > 0 &&
      frame.has_more !== false &&
      overlapStart + incoming.length >= prevTurns.length
    ) {
      const prefix = prevTurns.slice(0, overlapStart);
      let combined = [...prefix, ...reuseTurnRefs(incoming)];
      const prevFirstId = prevTurns[0]?.id;
      if (combined.length > maxRetained) {
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

  // 3. Authoritative snapshot window.
  const reused = prevTurns.length > 0 ? reuseTurnRefs(incoming) : incoming;
  return {
    turns: reused,
    windowReplaced: true,
    cursorInvalidated: false,
    hasMore: frame.has_more,
    beforeOffset: frame.before_offset ?? null,
  };
}

/** Prepend an older cursor page before current turns while deduplicating overlapping turn IDs. */
export function prependOlderTurns(olderTurns: AgentTurn[], currentTurns: AgentTurn[]): AgentTurn[] {
  if (olderTurns.length === 0) return currentTurns;
  const olderIds = new Set(olderTurns.map((t) => t.id));
  const tail = currentTurns.filter((t) => !olderIds.has(t.id));
  return [...olderTurns, ...tail];
}
