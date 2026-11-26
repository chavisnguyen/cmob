import { describe, expect, it } from "vite-plus/test";
import type { AgentTurn } from "../../protocol/event";
import {
  MAX_TURN_LIMIT,
  PENDING_WORKING_GRACE_MS,
  computeTurnDigest,
  createInitialChatSessionState,
  createPendingSendItem,
  hasFreshPendingSends,
  mergeIncomingSessionFrame,
  reduceChatSession,
  replayRetainedTailStart,
} from "./transcriptReducer";

function makeTurn(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp?: number,
): AgentTurn {
  return {
    id,
    surface_id: "surf-1",
    role,
    ...(timestamp !== undefined ? { timestamp } : {}),
    events: [role === "user" ? { kind: "user", text } : { kind: "assistant", text }],
  };
}

describe("transcriptReducer & turnMerge", () => {
  it("never reuses truncated turns over untrimmed live wire turns", () => {
    const fullText = "A".repeat(9_000);
    const fullTurn = makeTurn("t-1", "assistant", fullText);
    const trimmed: AgentTurn = {
      ...fullTurn,
      events: [{ kind: "assistant", text: `${fullText.slice(0, 8_000)}…` }],
      truncated: true,
    };

    const t2 = makeTurn("t-2", "user", "next");
    const merged = mergeIncomingSessionFrame({
      prevTurns: [trimmed, t2],
      frame: {
        update_kind: "snapshot",
        turns: [fullTurn, t2],
      },
      replaceSnapshot: true,
      maxRetained: 500,
    });

    expect(merged).not.toBeNull();
    expect(merged!.turns[0]).toBe(fullTurn);
    expect(merged!.turns[0].truncated).toBeUndefined();
    expect(merged!.turns[1]).toBe(t2);
  });

  it("detects in-place non-tail updates (answered, ok, subagent state, duration_secs)", () => {
    const baseTurn: AgentTurn = {
      id: "t-ask",
      surface_id: "surf-1",
      role: "assistant",
      events: [
        { kind: "thinking", text: "Planning", duration_secs: 4 },
        {
          kind: "subagents",
          group_id: "g-1",
          agents: [{ id: "sub-1", label: "Worker", state: "working" }],
        },
        {
          kind: "awaiting-input",
          input_kind: "question",
          prompt: "Proceed?",
          options: ["Yes", "No"],
        },
      ],
    };

    const updatedTurn: AgentTurn = {
      ...baseTurn,
      events: [
        { kind: "thinking", text: "Planning", duration_secs: 12 },
        {
          kind: "subagents",
          group_id: "g-1",
          agents: [{ id: "sub-1", label: "Worker", state: "completed" }],
        },
        {
          kind: "awaiting-input",
          input_kind: "question",
          prompt: "Proceed?",
          options: ["Yes", "No"],
          answered: "Yes",
        },
      ],
    };

    expect(computeTurnDigest(baseTurn)).not.toBe(computeTurnDigest(updatedTurn));

    const tail = makeTurn("t-tail", "user", "done");
    const res = mergeIncomingSessionFrame({
      prevTurns: [baseTurn, tail],
      frame: { turns: [updatedTurn, tail] },
      replaceSnapshot: true,
      maxRetained: 500,
    });
    expect(res!.turns[0]).toBe(updatedTurn);
    expect(res!.turns[1]).toBe(tail);
  });

  it("validates contiguous ID sequences in replayRetainedTailStart and rejects renumbered collisions", () => {
    const prev = [
      makeTurn("t-0", "user", "0"),
      makeTurn("t-1", "assistant", "1"),
      makeTurn("t-2", "user", "2"),
      makeTurn("t-3", "assistant", "3"),
    ];

    // Valid contiguous overlap [t-2, t-3, t-4]
    expect(
      replayRetainedTailStart(prev, [
        makeTurn("t-2", "user", "2"),
        makeTurn("t-3", "assistant", "3 updated"),
        makeTurn("t-4", "user", "4"),
      ]),
    ).toBe(2);

    // Invalid non-contiguous overlap [t-1, t-99] (missing t-2, t-3)
    expect(
      replayRetainedTailStart(prev, [
        makeTurn("t-1", "assistant", "collided"),
        makeTurn("t-99", "user", "wrong"),
      ]),
    ).toBeNull();

    // Invalid delta anchor pointing deep into history without matching subsequent turns
    const badDelta = mergeIncomingSessionFrame({
      prevTurns: prev,
      frame: {
        update_kind: "delta",
        after_turn_id: "t-0",
        tail_turns: [makeTurn("t-new", "assistant", "renumbered")],
      },
      replaceSnapshot: false,
      maxRetained: 500,
    });
    expect(badDelta).toBeNull();
  });

  it("never slices off newly prepended older pages when exceeding MAX_TURN_LIMIT", () => {
    const initial500 = Array.from({ length: MAX_TURN_LIMIT }, (_, idx) =>
      makeTurn(`turn-${idx + 30}`, idx % 2 === 0 ? "user" : "assistant", `msg ${idx + 30}`),
    );
    let state = createInitialChatSessionState("id-1", {
      turns: initial500,
      hasMore: true,
      beforeOffset: 1200,
      lifecycleState: "idle",
      isWorking: false,
      activityText: null,
    });

    const older30 = Array.from({ length: 30 }, (_, idx) =>
      makeTurn(`turn-${idx}`, idx % 2 === 0 ? "user" : "assistant", `older ${idx}`),
    );

    state = reduceChatSession(state, { type: "LOAD_OLDER_START" });
    state = reduceChatSession(state, {
      type: "LOAD_OLDER_CURSOR_SUCCESS",
      olderTurns: older30,
      beforeOffset: 400,
      hasMore: true,
      expectedCursor: 1200,
      now: 1_000,
    });

    expect(state.turns).toHaveLength(530);
    expect(state.turns[0].id).toBe("turn-0");
    expect(state.turns[529].id).toBe("turn-529");
  });

  it("reconciles pendingSends across <USER_REQUEST> and [Image #1] echoes, assistant replies, and grace window", () => {
    let state = createInitialChatSessionState("id-1", null, 1_000);
    const p1 = createPendingSendItem({
      id: "pending-1",
      text: "Fix login redirect",
      turns: state.turns,
      now: 1_000,
      imagePreviews: ["data:image/jpeg;base64,abc"],
    });

    state = reduceChatSession(state, { type: "ADD_PENDING_SEND", pending: p1, now: 1_000 });
    expect(hasFreshPendingSends(state.pendingSends, 1_000 + 5_000)).toBe(true);
    expect(hasFreshPendingSends(state.pendingSends, 1_000 + PENDING_WORKING_GRACE_MS + 1)).toBe(
      false,
    );

    // Echo arrives wrapped in <USER_REQUEST> + [Image #1] -> pendingSend clears cleanly!
    state = reduceChatSession(state, {
      type: "APPLY_SESSION_FRAME",
      isFollowing: true,
      now: 2_000,
      frame: {
        turns: [
          makeTurn(
            "u-1",
            "user",
            "<USER_REQUEST>\n[Image #1]\nFix login redirect\n</USER_REQUEST>",
          ),
        ],
        is_working: true,
      },
    });
    expect(state.pendingSends).toHaveLength(0);

    // Second send cleared by newly arrived assistant turn even without user echo
    const p2 = createPendingSendItem({
      id: "pending-2",
      text: "Run tests",
      turns: state.turns,
      now: 3_000,
    });
    state = reduceChatSession(state, { type: "ADD_PENDING_SEND", pending: p2, now: 3_000 });
    expect(state.pendingSends).toHaveLength(1);

    state = reduceChatSession(state, {
      type: "APPLY_SESSION_FRAME",
      isFollowing: true,
      now: 4_000,
      frame: {
        turns: [...state.turns, makeTurn("a-1", "assistant", "Running test suite...", 4_000)],
        is_working: true,
      },
    });
    expect(state.pendingSends).toHaveLength(0);
  });

  it("resets all transient session fields when cacheIdentity changes (/clear or agent restart)", () => {
    let state = createInitialChatSessionState("host|s1|claude|sid-1|", null, 1_000);
    state = reduceChatSession(state, {
      type: "APPLY_SESSION_FRAME",
      isFollowing: true,
      now: 1_500,
      frame: {
        turns: [makeTurn("t-1", "user", "hi")],
        is_working: true,
        lifecycle_state: "waiting",
        awaiting_prompt: "Approve bash?",
        startup_dialog: {
          kind: "trust",
          title: "Trust folder",
          description: "/repo",
          fingerprint: "fp-1",
          aimed: true,
          choices: [{ label: "Yes" }],
        },
      },
    });

    const reset = reduceChatSession(state, {
      type: "RESET_FOR_IDENTITY",
      cacheIdentity: "host|s1|claude|sid-2|",
      cached: null,
      now: 2_000,
    });

    expect(reset.sessionEpoch).toBe(1);
    expect(reset.turns).toEqual([]);
    expect(reset.startupDialog).toBeNull();
    expect(reset.awaitingPrompt).toBeNull();
    expect(reset.pendingSends).toEqual([]);
    expect(reset.isWorking).toBe(false);
    expect(reset.lifecycleState).toBe("idle");
    expect(reset.activityText).toBeNull();
    expect(reset.snapshotConfirmed).toBe(false);
  });
});
