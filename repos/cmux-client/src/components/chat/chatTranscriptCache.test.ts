import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentTurn } from "../../protocol/event";
import {
  buildTranscriptCacheKey,
  clearChatTranscriptCacheForTests,
  mergeIncomingSessionFrame,
  peekCachedChatTranscript,
  prependOlderTurns,
  writeCachedChatTranscript,
} from "./chatTranscriptCache";

function turn(id: string, role: "user" | "assistant", text: string): AgentTurn {
  return {
    id,
    surface_id: "surf-1",
    role,
    events: [role === "user" ? { kind: "user", text } : { kind: "assistant", text }],
  };
}

describe("chatTranscriptCache (in-memory only)", () => {
  beforeEach(() => {
    clearChatTranscriptCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches and evicts least-recently-used sessions in memory", () => {
    for (let i = 0; i < 18; i += 1) {
      const key = buildTranscriptCacheKey({
        endpoint: "ws://local",
        surfaceKey: `s-${i}`,
        agentKind: "claude",
        sessionId: `sid-${i}`,
      });
      writeCachedChatTranscript(key, {
        turns: [turn(`t-${i}`, "user", `hi ${i}`)],
        hasMore: false,
        beforeOffset: null,
        lifecycleState: "idle",
        isWorking: false,
        activityText: null,
        savedAt: i,
      });
    }

    const evicted = buildTranscriptCacheKey({
      endpoint: "ws://local",
      surfaceKey: "s-0",
      agentKind: "claude",
      sessionId: "sid-0",
    });
    const newest = buildTranscriptCacheKey({
      endpoint: "ws://local",
      surfaceKey: "s-17",
      agentKind: "claude",
      sessionId: "sid-17",
    });

    expect(peekCachedChatTranscript(evicted)).toBeNull();
    expect(peekCachedChatTranscript(newest)?.turns[0]?.id).toBe("t-17");
  });

  it("purges legacy cmux.chat.transcriptCache.v1 from localStorage and never writes back to disk", () => {
    const store = new Map<string, string>([
      ["cmux.chat.transcriptCache.v1", '{"v":1,"entries":[]}'],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });

    const key = buildTranscriptCacheKey({
      endpoint: "ws://local",
      surfaceKey: "surf-1",
      agentKind: "antigravity",
      sessionId: "sid-1",
    });

    expect(peekCachedChatTranscript(key)).toBeNull();
    expect(store.has("cmux.chat.transcriptCache.v1")).toBe(false);

    writeCachedChatTranscript(key, {
      turns: [turn("t-1", "user", "in-memory only")],
      hasMore: false,
      beforeOffset: null,
      lifecycleState: "working",
      isWorking: true,
      activityText: "Thinking…",
      savedAt: 1_000,
    });
    expect(store.size).toBe(0);
    expect(peekCachedChatTranscript(key)?.turns[0]?.id).toBe("t-1");
  });

  it("applies incremental delta frames in O(1) while preserving historical turn references", () => {
    const t1 = turn("turn-@100", "user", "hello");
    const t2 = turn("turn-@200", "assistant", "first reply");
    const t3 = turn("turn-@300", "user", "follow up");
    const t4 = turn("turn-@400", "assistant", "streaming...");

    const updatedT4 = turn("turn-@400", "assistant", "streaming complete!");
    const appendedT5 = turn("turn-@500", "user", "thanks");

    const res = mergeIncomingSessionFrame({
      prevTurns: [t1, t2, t3, t4],
      frame: {
        update_kind: "delta",
        after_turn_id: "turn-@300",
        tail_turns: [updatedT4, appendedT5],
      },
      replaceSnapshot: false,
      maxRetained: 500,
    });

    expect(res).not.toBeNull();
    expect(res!.windowReplaced).toBe(false);
    expect(res!.turns.map((t) => t.id)).toEqual([
      "turn-@100",
      "turn-@200",
      "turn-@300",
      "turn-@400",
      "turn-@500",
    ]);
    expect(res!.turns[0]).toBe(t1);
    expect(res!.turns[1]).toBe(t2);
    expect(res!.turns[2]).toBe(t3);
    expect(res!.turns[3]).toBe(updatedT4);
  });

  it("retains paged-back history across overlapping reconnect snapshots", () => {
    const older1 = turn("turn-@10", "user", "old 1");
    const older2 = turn("turn-@20", "assistant", "old 2");
    const mid1 = turn("turn-@30", "user", "mid 1");
    const tail1 = turn("turn-@40", "assistant", "tail 1");

    const updatedTail1 = turn("turn-@40", "assistant", "tail 1 updated");
    const tail2 = turn("turn-@50", "user", "tail 2");

    const res = mergeIncomingSessionFrame({
      prevTurns: [older1, older2, mid1, tail1],
      frame: {
        update_kind: "snapshot",
        has_more: true,
        before_offset: 30,
        turns: [mid1, updatedTail1, tail2],
      },
      replaceSnapshot: false,
      maxRetained: 500,
    });

    expect(res!.windowReplaced).toBe(false);
    expect(res!.turns.map((t) => t.id)).toEqual([
      "turn-@10",
      "turn-@20",
      "turn-@30",
      "turn-@40",
      "turn-@50",
    ]);
  });

  it("prepends older pages without duplicating overlapping turn IDs", () => {
    const t1 = turn("turn-@10", "user", "1");
    const t2 = turn("turn-@20", "assistant", "2");
    const t3 = turn("turn-@30", "user", "3");
    const combined = prependOlderTurns([t1, t2], [t2, t3]);
    expect(combined.map((t) => t.id)).toEqual(["turn-@10", "turn-@20", "turn-@30"]);
  });
});
