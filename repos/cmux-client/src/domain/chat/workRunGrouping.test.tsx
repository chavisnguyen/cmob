import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { MobileNativeChatPromptCard } from "../../components/chat/MobileNativeChatPromptCard";
import type { AgentTurn } from "../../protocol/event";
import { buildChatViewModel } from "./chatViewModel";
import { clearComposerStoreForTests, getComposerState, updateComposerState } from "./composerStore";
import {
  MAX_DISCLOSURES,
  clearDisclosureStoreForTests,
  getDisclosureState,
  setDisclosureState,
} from "./disclosureStore";
import { selectComposerDock } from "./dockSelector";
import { buildAssistantBlocks } from "./workRunGrouping";

describe("toolPairing, workRunGrouping, dockSelector & stores", () => {
  beforeEach(() => {
    clearDisclosureStoreForTests();
    clearComposerStoreForTests();
  });

  it("pairs tool-start and tool-end across intervening thinking events without stuck live or orphan rows", () => {
    const blocks = buildAssistantBlocks({
      turnId: "t-1",
      isLastTurn: true,
      isWorking: true,
      activeAwaitingEventIdx: null,
      activeAwaitingRef: null,
      events: [
        { kind: "tool-start", tool_id: "cmd-1", name: "run_command", detail: "npm test" },
        { kind: "thinking", text: "Inspecting test output", duration_secs: 6 },
        { kind: "tool-end", tool_id: "cmd-1", detail: "PASS", ok: true },
        { kind: "thinking", text: "Formulating summary..." },
      ],
    });

    // Settled tool + settled thought grouped into one WorkRunBlock, trailing live Reasoning kept separate!
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("work-run");
    if (blocks[0].kind === "work-run") {
      expect(blocks[0].live).toBe(false);
      expect(blocks[0].tools).toHaveLength(1);
      expect(blocks[0].tools[0]).toMatchObject({
        id: "cmd-1",
        name: "run_command",
        inputDetail: "npm test",
        detail: "PASS",
        ok: true,
        isEnd: true,
      });
      expect(blocks[0].thoughts).toHaveLength(1);
      expect(blocks[0].steps.map((s) => s.kind)).toEqual(["tool", "thinking"]);
    }

    expect(blocks[1]).toMatchObject({
      kind: "live-reasoning",
      live: true,
      text: "Formulating summary...",
    });
  });

  it("coalesces consecutive delta events and drops superseded deltas when finalized assistant prose exists", () => {
    const streamingBlocks = buildAssistantBlocks({
      turnId: "t-stream",
      isLastTurn: true,
      isWorking: true,
      activeAwaitingEventIdx: null,
      activeAwaitingRef: null,
      events: [
        { kind: "delta", text: "Hello " },
        { kind: "delta", text: "world!" },
      ],
    });
    expect(streamingBlocks).toEqual([
      { kind: "prose", key: "t-stream:prose:0", text: "Hello world!" },
    ]);

    const finalizedBlocks = buildAssistantBlocks({
      turnId: "t-final",
      isLastTurn: false,
      isWorking: false,
      activeAwaitingEventIdx: null,
      activeAwaitingRef: null,
      events: [
        { kind: "delta", text: "Hello " },
        { kind: "delta", text: "world" },
        { kind: "assistant", text: "Hello world!" },
      ],
    });
    expect(finalizedBlocks).toHaveLength(1);
    expect(finalizedBlocks[0]).toEqual({
      kind: "prose",
      key: "t-final:prose:0",
      text: "Hello world!",
    });
  });

  it("enforces dock mutual exclusion (startupDialog > question > permission) and distinct promptInstanceKey", () => {
    const dialog = {
      kind: "trust",
      title: "Trust workspace",
      description: "Trust?",
      fingerprint: "fp",
      aimed: true,
      choices: [{ label: "Trust" }],
    };
    const turnQ1: AgentTurn = {
      id: "turn-a",
      surface_id: "s-1",
      role: "assistant",
      events: [
        {
          kind: "awaiting-input",
          input_kind: "question",
          prompt: "Choose env",
          options: ["Dev", "Prod"],
        },
      ],
    };

    // Unconfirmed snapshot hides dock prompts until live confirmation arrives
    expect(
      selectComposerDock({
        turns: [turnQ1],
        isWorking: true,
        lifecycleState: "working",
        startupDialog: dialog,
        snapshotConfirmed: false,
      }).dock.kind,
    ).toBe("none");

    // Startup dialog outranks question and permission
    expect(
      selectComposerDock({
        turns: [turnQ1],
        isWorking: false,
        lifecycleState: "waiting",
        startupDialog: dialog,
        awaitingPrompt: "Approve?",
        snapshotConfirmed: true,
      }).dock.kind,
    ).toBe("startup-dialog");

    const q1Dock = selectComposerDock({
      turns: [turnQ1],
      isWorking: true,
      lifecycleState: "working",
    }).dock;
    expect(q1Dock.kind).toBe("question");

    // Q1 answered, Q2 appended with identical prompt text in same turn -> new eventIdx -> new key!
    const turnQ2: AgentTurn = {
      ...turnQ1,
      events: [
        { ...turnQ1.events[0], answered: "Dev" } as AgentTurn["events"][number],
        {
          kind: "awaiting-input",
          input_kind: "question",
          prompt: "Choose env",
          options: ["Dev", "Prod"],
        },
      ],
    };
    const q2Dock = selectComposerDock({
      turns: [turnQ2],
      isWorking: true,
      lifecycleState: "working",
    }).dock;
    expect(q2Dock.kind).toBe("question");
    if (q1Dock.kind === "question" && q2Dock.kind === "question") {
      expect(q2Dock.promptInstanceKey).not.toBe(q1Dock.promptInstanceKey);
    }
  });

  it("suppresses redundant bottom Thinking… spinner when tail block is an inline live row unless stopping", () => {
    const liveReasoningTurn: AgentTurn = {
      id: "t-1",
      surface_id: "s-1",
      role: "assistant",
      events: [{ kind: "thinking", text: "Deep thought..." }],
    };

    const vmLiveRow = buildChatViewModel({
      turns: [liveReasoningTurn],
      isWorking: true,
      activityText: "Thinking…",
      isStopping: false,
    });
    expect(vmLiveRow.effectivelyWorking).toBe(true);
    expect(vmLiveRow.liveActivity.visible).toBe(false);

    const vmStopping = buildChatViewModel({
      turns: [liveReasoningTurn],
      isWorking: true,
      activityText: "Thinking…",
      isStopping: true,
    });
    expect(vmStopping.liveActivity).toEqual({
      visible: true,
      activityText: "Stopping…",
      stopping: true,
    });

    // Settled `done` tail stops working when no subagents are active
    const settledDoneTurn: AgentTurn = {
      id: "t-done",
      surface_id: "s-1",
      role: "assistant",
      events: [{ kind: "assistant", text: "All done." }, { kind: "done" }],
    };
    const vmDone = buildChatViewModel({
      turns: [settledDoneTurn],
      isWorking: true,
    });
    expect(vmDone.effectivelyWorking).toBe(false);
  });

  it("persists per-surface disclosures (512 LRU) and composer state across tab toggles", () => {
    for (let i = 0; i < MAX_DISCLOSURES + 5; i += 1) {
      setDisclosureState("surf-1", `item-${i}`, true);
    }
    expect(getDisclosureState("surf-1", "item-0", false)).toBe(false);
    expect(getDisclosureState("surf-1", `item-${MAX_DISCLOSURES + 4}`, false)).toBe(true);
    expect(getDisclosureState("surf-2", `item-${MAX_DISCLOSURES + 4}`, false)).toBe(false);

    updateComposerState("surf-1", (prev) => ({
      ...prev,
      draftText: "unsent draft",
      chosenModel: "opus",
      chosenEffort: "high",
    }));
    expect(getComposerState("surf-1")).toMatchObject({
      draftText: "unsent draft",
      chosenModel: "opus",
      chosenEffort: "high",
    });
    expect(getComposerState("surf-2").draftText).toBe("");
  });

  it("renders stepped 1/N wizard badge in MobileNativeChatPromptCard for multi-question prompts", () => {
    const html = renderToStaticMarkup(
      <MobileNativeChatPromptCard
        awaiting={{
          input_kind: "question",
          prompt: "Multi-step wizard",
          questions: [
            { question: "Pick framework", options: ["React", "Solid"] },
            { question: "Pick styling", options: ["Tailwind", "CSS Modules"] },
          ],
        }}
        onAnswer={async () => {}}
      />,
    );
    expect(html).toContain("1/2");
    expect(html).toContain("Pick framework");
  });
});
