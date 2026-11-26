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

const LEGACY_STORAGE_KEY = "cmux.chat.transcriptCache.v1";
const MAX_MEMORY_ENTRIES = 16;

const memoryCache = new Map<string, CachedChatTranscript>();
let purgedLegacyDiskCache = false;

function purgeLegacyDiskCacheOnce(): void {
  if (purgedLegacyDiskCache) return;
  purgedLegacyDiskCache = true;
  try {
    if (typeof window !== "undefined" && typeof window.localStorage?.removeItem === "function") {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    // Ignore restricted storage environments.
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

/**
 * Session-scoped in-memory transcript cache (Orca Web pattern: zero localStorage I/O).
 * Switching back and forth between open tabs in the current session is 0ms with untrimmed turns,
 * while reloads/cold launches always fetch clean live truth without 5MB Safari quota stalls.
 */
export function peekCachedChatTranscript(identity: string): CachedChatTranscript | null {
  purgeLegacyDiskCacheOnce();
  const hit = memoryCache.get(identity);
  if (!hit) return null;
  memoryCache.delete(identity);
  memoryCache.set(identity, hit);
  return hit;
}

export function writeCachedChatTranscript(identity: string, entry: CachedChatTranscript): void {
  purgeLegacyDiskCacheOnce();
  memoryCache.delete(identity);
  memoryCache.set(identity, entry);
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

export function clearChatTranscriptCacheForTests(): void {
  memoryCache.clear();
  purgedLegacyDiskCache = false;
}
