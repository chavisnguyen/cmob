import type {
  AgentLifecycleState,
  AgentTurn,
  BackgroundTaskEntry,
  StartupDialogInfo,
  SubagentEntry,
} from "../../protocol/event";
import {
  countMatchingUserTurns,
  extractNormalizedUserTurnKeys,
  normalizeComparablePrompt,
} from "./cleanPrompt";
import {
  computeTurnDigest,
  mergeIncomingSessionFrame,
  prependOlderTurns,
  replayRetainedTailStart,
  turnsStructurallyEqual,
} from "./turnMerge";
import type { PendingSendItem, WireSessionFrame } from "./types";

export {
  computeTurnDigest,
  mergeIncomingSessionFrame,
  prependOlderTurns,
  replayRetainedTailStart,
  turnsStructurallyEqual,
};

export const INITIAL_TURN_PAGE_SIZE = 15;
export const OLDER_TURN_PAGE_SIZE = 30;
export const MAX_TURN_LIMIT = 500;
const HARD_PAGED_RETENTION_CEILING = 5_000;

export const PENDING_SEND_TTL_MS = 90_000;
export const PENDING_WORKING_GRACE_MS = 20_000;

export function cleanActivity(text: string | null | undefined): string | null {
  const line = text?.split("\n")[0]?.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function hasNewAssistantReplyAfter(turns: readonly AgentTurn[], pending: PendingSendItem): boolean {
  let currentAssistantCount = 0;
  for (const t of turns) {
    if (t.role === "assistant") {
      currentAssistantCount += 1;
      if (typeof t.timestamp === "number" && t.timestamp > pending.createdAt) {
        return true;
      }
    }
  }
  if (currentAssistantCount > pending.baselineAssistantCount) {
    return true;
  }
  if (pending.baselineLastTurnId === null) {
    return currentAssistantCount > 0;
  }
  const anchorIdx = turns.findIndex((t) => t.id === pending.baselineLastTurnId);
  if (anchorIdx !== -1) {
    for (let i = anchorIdx + 1; i < turns.length; i += 1) {
      if (turns[i].role === "assistant") {
        return true;
      }
    }
  }
  return false;
}

export function reconcilePendingSends(
  pendingSends: readonly PendingSendItem[],
  turns: readonly AgentTurn[],
  now: number,
): PendingSendItem[] {
  if (pendingSends.length === 0) return pendingSends as PendingSendItem[];

  const counts = new Map<string, number>();
  for (const key of extractNormalizedUserTurnKeys(turns)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const used = new Map<string, number>();
  const remaining = pendingSends.filter((p) => {
    if (now - p.createdAt > PENDING_SEND_TTL_MS) return false;
    if (hasNewAssistantReplyAfter(turns, p)) return false;

    const key = p.normalizedText;
    const needed = p.baseline + 1 + (used.get(key) ?? 0);
    used.set(key, (used.get(key) ?? 0) + 1);
    return (counts.get(key) ?? 0) < needed;
  });

  return remaining.length === pendingSends.length ? (pendingSends as PendingSendItem[]) : remaining;
}

export function hasFreshPendingSends(
  pendingSends: readonly PendingSendItem[],
  now: number,
): boolean {
  return pendingSends.some((p) => now - p.createdAt < PENDING_WORKING_GRACE_MS);
}

export function createPendingSendItem(params: {
  id: string;
  text: string;
  turns: readonly AgentTurn[];
  now: number;
  imagePreviews?: string[];
}): PendingSendItem {
  const hasImages = Boolean(params.imagePreviews && params.imagePreviews.length > 0);
  const assistantCount = params.turns.reduce(
    (acc, t) => (t.role === "assistant" ? acc + 1 : acc),
    0,
  );
  return {
    id: params.id,
    text: params.text,
    normalizedText: normalizeComparablePrompt(params.text, hasImages),
    baseline: countMatchingUserTurns(params.turns, params.text, hasImages),
    baselineLastTurnId: params.turns.length > 0 ? params.turns[params.turns.length - 1].id : null,
    baselineAssistantCount: assistantCount,
    createdAt: params.now,
    ...(hasImages ? { imagePreviews: [...params.imagePreviews!] } : {}),
  };
}

export interface ChatSessionState {
  cacheIdentity: string;
  sessionEpoch: number;
  turns: AgentTurn[];
  initialLoading: boolean;
  snapshotSeen: boolean;
  snapshotConfirmed: boolean;
  turnLimit: number;
  retainedLimit: number;
  hasMoreHistory: boolean;
  beforeOffset: number | null;
  loadingOlder: boolean;
  pendingSends: PendingSendItem[];
  startupDialog: StartupDialogInfo | null;
  isWorking: boolean;
  lifecycleState: AgentLifecycleState;
  activityText: string | null;
  awaitingPrompt: string | null;
  activeSubagents: SubagentEntry[];
  activeBackgroundTasks: BackgroundTaskEntry[];
  now: number;
}

export interface CachedTranscriptSeed {
  turns: AgentTurn[];
  hasMore: boolean;
  beforeOffset: number | null;
  lifecycleState: AgentLifecycleState;
  isWorking: boolean;
  activityText: string | null;
}

export type ChatSessionAction =
  | {
      type: "RESET_FOR_IDENTITY";
      cacheIdentity: string;
      cached: CachedTranscriptSeed | null;
      now: number;
    }
  | {
      type: "APPLY_SESSION_FRAME";
      frame: WireSessionFrame;
      isFollowing: boolean;
      now: number;
    }
  | { type: "LOAD_OLDER_START" }
  | {
      type: "LOAD_OLDER_CURSOR_SUCCESS";
      olderTurns: AgentTurn[];
      beforeOffset: number | null;
      hasMore: boolean;
      expectedCursor: number;
      now: number;
    }
  | {
      type: "LOAD_OLDER_WINDOW_SUCCESS";
      turns: AgentTurn[];
      nextTurnLimit: number;
      hasMore: boolean;
      now: number;
    }
  | { type: "LOAD_OLDER_FINISH" }
  | { type: "ADD_PENDING_SEND"; pending: PendingSendItem; now: number }
  | { type: "REMOVE_PENDING_SEND"; id: string; now: number }
  | { type: "MARK_OPTIMISTIC_WORKING"; activityText?: string; now: number }
  | {
      type: "REVERT_OPTIMISTIC_WORKING";
      lifecycleState?: AgentLifecycleState;
      now: number;
    }
  | { type: "CLEAR_STARTUP_DIALOG" }
  | { type: "TICK_NOW"; now: number };

export function createInitialChatSessionState(
  cacheIdentity: string,
  cached: CachedTranscriptSeed | null,
  now = Date.now(),
): ChatSessionState {
  const seededTurns = cached?.turns ?? [];
  return {
    cacheIdentity,
    sessionEpoch: 0,
    turns: seededTurns,
    initialLoading: seededTurns.length === 0,
    snapshotSeen: false,
    snapshotConfirmed: false,
    turnLimit: INITIAL_TURN_PAGE_SIZE,
    retainedLimit: Math.max(MAX_TURN_LIMIT, seededTurns.length),
    hasMoreHistory: cached?.hasMore ?? false,
    beforeOffset: cached?.beforeOffset ?? null,
    loadingOlder: false,
    pendingSends: [],
    startupDialog: null,
    isWorking: cached?.isWorking ?? false,
    lifecycleState: cached?.lifecycleState ?? "idle",
    activityText: cached?.activityText ?? null,
    awaitingPrompt: null,
    activeSubagents: [],
    activeBackgroundTasks: [],
    now,
  };
}

function sameStartupDialog(
  prev: StartupDialogInfo | null,
  next: StartupDialogInfo | null,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return (
    prev.fingerprint === next.fingerprint &&
    prev.title === next.title &&
    prev.description === next.description &&
    prev.aimed === next.aimed &&
    prev.choices.length === next.choices.length &&
    prev.choices.every((c, idx) => c.label === next.choices[idx]?.label)
  );
}

export function reduceChatSession(
  state: ChatSessionState,
  action: ChatSessionAction,
): ChatSessionState {
  switch (action.type) {
    case "RESET_FOR_IDENTITY": {
      const seededTurns = action.cached?.turns ?? [];
      return {
        cacheIdentity: action.cacheIdentity,
        sessionEpoch: state.sessionEpoch + 1,
        turns: seededTurns,
        initialLoading: seededTurns.length === 0,
        snapshotSeen: false,
        snapshotConfirmed: false,
        turnLimit: INITIAL_TURN_PAGE_SIZE,
        retainedLimit: Math.max(MAX_TURN_LIMIT, seededTurns.length),
        hasMoreHistory: action.cached?.hasMore ?? false,
        beforeOffset: action.cached?.beforeOffset ?? null,
        loadingOlder: false,
        pendingSends: [],
        startupDialog: null,
        isWorking: action.cached?.isWorking ?? false,
        lifecycleState: action.cached?.lifecycleState ?? "idle",
        activityText: action.cached?.activityText ?? null,
        awaitingPrompt: null,
        activeSubagents: [],
        activeBackgroundTasks: [],
        now: action.now,
      };
    }

    case "APPLY_SESSION_FRAME": {
      const { frame, isFollowing, now } = action;
      const effectiveMaxRetained =
        isFollowing && state.retainedLimit <= MAX_TURN_LIMIT
          ? MAX_TURN_LIMIT
          : Math.max(state.retainedLimit, state.turns.length + (frame.tail_turns?.length ?? 32));

      const merged = mergeIncomingSessionFrame({
        prevTurns: state.turns,
        frame,
        replaceSnapshot: !state.snapshotSeen,
        maxRetained: Math.min(HARD_PAGED_RETENTION_CEILING, effectiveMaxRetained),
      });

      let nextTurns = state.turns;
      let nextSnapshotSeen = state.snapshotSeen;
      let nextBeforeOffset = state.beforeOffset;
      let nextHasMore = state.hasMoreHistory;

      if (merged) {
        nextTurns = merged.turns;
        nextSnapshotSeen = true;
        if (merged.windowReplaced) {
          nextBeforeOffset = merged.beforeOffset ?? null;
          if (merged.hasMore !== undefined) nextHasMore = merged.hasMore;
        } else {
          if (merged.beforeOffset !== undefined) nextBeforeOffset = merged.beforeOffset;
          if (merged.hasMore !== undefined) nextHasMore = merged.hasMore;
        }
      } else if (frame.has_more !== undefined) {
        nextHasMore = frame.has_more;
      }

      const incomingDialog = frame.startup_dialog ?? null;
      const nextStartupDialog = sameStartupDialog(state.startupDialog, incomingDialog)
        ? state.startupDialog
        : incomingDialog;
      const nextAwaitingPrompt =
        frame.awaiting_prompt !== undefined
          ? (frame.awaiting_prompt ?? null)
          : state.awaitingPrompt;

      let nextLifecycle = state.lifecycleState;
      if (frame.lifecycle_state) nextLifecycle = frame.lifecycle_state;
      else if (frame.is_working !== undefined)
        nextLifecycle = frame.is_working ? "working" : "idle";

      let nextIsWorking = state.isWorking;
      let nextActivityText = state.activityText;
      if (frame.is_working !== undefined) {
        nextIsWorking = frame.is_working;
        nextActivityText = frame.is_working ? (cleanActivity(frame.activity) ?? "Thinking…") : null;
      }

      const nextActiveSubagents = Array.isArray(frame.active_subagents)
        ? frame.active_subagents
        : state.activeSubagents;
      const nextActiveBackgroundTasks = Array.isArray(frame.active_background_tasks)
        ? frame.active_background_tasks
        : state.activeBackgroundTasks;

      const hasTurnPayload = Array.isArray(frame.turns) || Array.isArray(frame.tail_turns);
      return {
        ...state,
        turns: nextTurns,
        snapshotSeen: nextSnapshotSeen,
        snapshotConfirmed: hasTurnPayload ? true : state.snapshotConfirmed,
        initialLoading: hasTurnPayload ? false : state.initialLoading,
        beforeOffset: nextBeforeOffset,
        hasMoreHistory: nextHasMore,
        startupDialog: nextStartupDialog,
        awaitingPrompt: nextAwaitingPrompt,
        lifecycleState: nextLifecycle,
        isWorking: nextIsWorking,
        activityText: nextActivityText,
        activeSubagents: nextActiveSubagents,
        activeBackgroundTasks: nextActiveBackgroundTasks,
        pendingSends: reconcilePendingSends(state.pendingSends, nextTurns, now),
        now,
      };
    }

    case "LOAD_OLDER_START":
      return state.loadingOlder ? state : { ...state, loadingOlder: true };

    case "LOAD_OLDER_CURSOR_SUCCESS": {
      if (state.beforeOffset !== action.expectedCursor) {
        return { ...state, loadingOlder: false };
      }
      const nextTurns = prependOlderTurns(action.olderTurns, state.turns);
      return {
        ...state,
        turns: nextTurns,
        retainedLimit: Math.min(
          HARD_PAGED_RETENTION_CEILING,
          Math.max(state.retainedLimit, nextTurns.length + OLDER_TURN_PAGE_SIZE),
        ),
        beforeOffset: action.beforeOffset,
        hasMoreHistory: Boolean(action.hasMore && action.beforeOffset !== null),
        loadingOlder: false,
        pendingSends: reconcilePendingSends(state.pendingSends, nextTurns, action.now),
        now: action.now,
      };
    }

    case "LOAD_OLDER_WINDOW_SUCCESS": {
      const incoming = action.turns;
      const lastOlderId = incoming[incoming.length - 1]?.id;
      const liveTailIdx = lastOlderId ? state.turns.findIndex((t) => t.id === lastOlderId) : -1;
      const nextTurns =
        liveTailIdx === -1 ? incoming : [...incoming, ...state.turns.slice(liveTailIdx + 1)];
      return {
        ...state,
        turns: nextTurns,
        turnLimit: action.nextTurnLimit,
        retainedLimit: Math.min(
          HARD_PAGED_RETENTION_CEILING,
          Math.max(state.retainedLimit, nextTurns.length + OLDER_TURN_PAGE_SIZE),
        ),
        hasMoreHistory: Boolean(action.hasMore && action.nextTurnLimit < MAX_TURN_LIMIT),
        loadingOlder: false,
        pendingSends: reconcilePendingSends(state.pendingSends, nextTurns, action.now),
        now: action.now,
      };
    }

    case "LOAD_OLDER_FINISH":
      return state.loadingOlder ? { ...state, loadingOlder: false } : state;

    case "ADD_PENDING_SEND":
      return {
        ...state,
        pendingSends: [...state.pendingSends, action.pending],
        isWorking: true,
        lifecycleState: "working",
        activityText: "Thinking…",
        now: action.now,
      };

    case "REMOVE_PENDING_SEND": {
      const nextPending = state.pendingSends.filter((p) => p.id !== action.id);
      return {
        ...state,
        pendingSends: nextPending,
        isWorking: nextPending.length > 0,
        activityText: nextPending.length > 0 ? state.activityText : null,
        now: action.now,
      };
    }

    case "MARK_OPTIMISTIC_WORKING":
      return {
        ...state,
        isWorking: true,
        lifecycleState: "working",
        activityText: action.activityText ?? "Thinking…",
        now: action.now,
      };

    case "REVERT_OPTIMISTIC_WORKING":
      return {
        ...state,
        isWorking: false,
        lifecycleState: action.lifecycleState ?? state.lifecycleState,
        activityText: null,
        now: action.now,
      };

    case "CLEAR_STARTUP_DIALOG":
      return state.startupDialog ? { ...state, startupDialog: null } : state;

    case "TICK_NOW": {
      const nextPending = reconcilePendingSends(state.pendingSends, state.turns, action.now);
      if (nextPending === state.pendingSends && state.now === action.now) return state;
      return { ...state, pendingSends: nextPending, now: action.now };
    }
  }
}
