import type { AgentLifecycleState, AgentTurn } from "../../protocol/event";
import { mergeIncomingSessionFrame, prependOlderTurns } from "../../domain/chat/transcriptReducer";
import type { WireSessionFrame } from "../../domain/chat/types";

export { mergeIncomingSessionFrame, prependOlderTurns };
export type { WireSessionFrame };

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

export function trimTurnForStorage(turn: AgentTurn): AgentTurn {
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
  return mutated ? { ...turn, events, truncated: true } : turn;
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
