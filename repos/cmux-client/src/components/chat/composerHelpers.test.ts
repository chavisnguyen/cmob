import { describe, expect, it } from "vite-plus/test";
import {
  canDrain,
  enqueue,
  queueStatusLabel,
  removeQueued,
  resolveEffectiveAwaiting,
} from "./chatQueue";
import { slashCommandsFor, suggestSlashCommands } from "./slashCommands";

describe("slash commands", () => {
  it("uses Orca's per-agent lists and falls back to the common set", () => {
    expect(slashCommandsFor("claude").map((c) => c.name)).toContain("compact");
    expect(slashCommandsFor("openclaude").map((c) => c.name)).toContain("init");
    expect(slashCommandsFor("codex").map((c) => c.name)).toContain("permissions");
    expect(slashCommandsFor("kiro").map((c) => c.name)).toEqual(["clear", "help"]);
    expect(slashCommandsFor(undefined).map((c) => c.name)).toEqual(["clear", "help"]);
  });

  it("suggests only for a bare /token", () => {
    expect(suggestSlashCommands("claude", "hello")).toEqual([]);
    expect(suggestSlashCommands("claude", "/clear now")).toEqual([]);
    expect(suggestSlashCommands("claude", "/").length).toBe(5);
    expect(suggestSlashCommands("claude", "/co").map((c) => c.name)).toEqual(["compact"]);
  });

  it("ranks prefix matches before substring matches", () => {
    const names = suggestSlashCommands("codex", "/m", 16).map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(["model", "memories"]); // prefix matches, list order
    expect(names).toContain("permissions"); // substring match ("per-m-issions")
    expect(names.indexOf("permissions")).toBeGreaterThan(names.indexOf("memories"));
  });

  it("respects the limit", () => {
    expect(suggestSlashCommands("codex", "/", 3)).toHaveLength(3);
  });
});

describe("message queue", () => {
  it("enqueues trimmed text in order and ignores blanks", () => {
    let q = enqueue([], "  one ", "a");
    q = enqueue(q, "   ", "b");
    q = enqueue(q, "two", "c");
    expect(q).toEqual([
      { id: "a", text: "one", images: [] },
      { id: "c", text: "two", images: [] },
    ]);
    expect(removeQueued(q, "a")).toEqual([{ id: "c", text: "two", images: [] }]);
  });

  const idle = {
    queueLength: 1,
    isWorking: false,
    isSubmitting: false,
    lifecycle: "idle",
    needsAnswer: false,
  };
  it("drains only when the agent is idle and nothing needs an answer", () => {
    expect(canDrain(idle)).toBe(true);
    expect(canDrain({ ...idle, queueLength: 0 })).toBe(false);
    expect(canDrain({ ...idle, isWorking: true })).toBe(false);
    expect(canDrain({ ...idle, isSubmitting: true })).toBe(false);
    expect(canDrain({ ...idle, needsAnswer: true })).toBe(false);
    expect(canDrain({ ...idle, lifecycle: "waiting" })).toBe(false);
    expect(canDrain({ ...idle, lifecycle: "working" })).toBe(false);
    expect(canDrain({ ...idle, lifecycle: "done" })).toBe(true);
  });

  it("synthesizes a 1-tap approval prompt when lifecycle is waiting without transcript awaiting-input", () => {
    expect(
      resolveEffectiveAwaiting({
        latestAwaiting: null,
        lifecycleState: "waiting",
        isWorking: false,
        startupDialog: null,
        awaitingPrompt: "Approve tool: Bash",
      }),
    ).toEqual({ input_kind: "permission", prompt: "Approve tool: Bash" });

    expect(
      resolveEffectiveAwaiting({
        latestAwaiting: null,
        lifecycleState: "waiting",
        isWorking: true,
        startupDialog: null,
        awaitingPrompt: "Approve tool: Bash",
      }),
    ).toBeNull();
  });

  it("labels queued items accurately when paused or waiting for approval", () => {
    expect(
      queueStatusLabel({ index: 0, queuePaused: true, lifecycleState: "idle", needsAnswer: false }),
    ).toBe("Paused");
    expect(
      queueStatusLabel({
        index: 0,
        queuePaused: false,
        lifecycleState: "waiting",
        needsAnswer: true,
      }),
    ).toBe("Waiting for approval");
    expect(
      queueStatusLabel({
        index: 0,
        queuePaused: false,
        lifecycleState: "working",
        needsAnswer: false,
      }),
    ).toBe("Queued");
  });
});

import { appendDictation } from "./dictation";

describe("dictation", () => {
  it("joins fragments with a single space", () => {
    expect(appendDictation("", " hello ")).toBe("hello");
    expect(appendDictation("fix the bug  ", "in main")).toBe("fix the bug in main");
    expect(appendDictation("draft", "   ")).toBe("draft");
  });
});

import { toggleMuted } from "../hosts/NotificationPrefs";

describe("notification prefs", () => {
  it("muting adds, enabling removes, result is sorted and deduplicated", () => {
    expect(toggleMuted([], "turn-finished", false)).toEqual(["turn-finished"]);
    expect(toggleMuted(["turn-finished"], "cmux-dialog", false)).toEqual([
      "cmux-dialog",
      "turn-finished",
    ]);
    expect(toggleMuted(["turn-finished", "turn-finished"], "turn-finished", true)).toEqual([]);
  });
});

import { fitDimensions, formatImagePastePath } from "./imageAttach";
import { contextTokens, formatTokens, latestUsage } from "./usageSummary";
import type { AgentTurn } from "../../protocol/event";

describe("image attach helpers", () => {
  it("pastes safe paths raw and escapes unsafe ones like Orca", () => {
    expect(formatImagePastePath("/Users/me/.cmux/uploads/ab12.png")).toBe(
      "/Users/me/.cmux/uploads/ab12.png",
    );
    expect(formatImagePastePath("/Users/John Doe/.cmux/uploads/a.png")).toBe(
      "/Users/John\\ Doe/.cmux/uploads/a.png",
    );
    expect(formatImagePastePath("/tmp/a$b.png")).toBe("/tmp/a\\$b.png");
    expect(formatImagePastePath("/tmp/a\nb.png")).toBeNull();
  });

  it("scales down only, keeping the aspect ratio", () => {
    expect(fitDimensions(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitDimensions(1000, 500, 2048)).toEqual({ width: 1000, height: 500 });
    expect(fitDimensions(3000, 1, 1000)).toEqual({ width: 1000, height: 1 });
  });

  it("queued messages may be image-only", () => {
    expect(enqueue([], "  ", "a", ["/p.png"])).toEqual([{ id: "a", text: "", images: ["/p.png"] }]);
    expect(enqueue([], "  ", "a")).toEqual([]);
  });
});

describe("usage summary", () => {
  const turn = (events: AgentTurn["events"]): AgentTurn => ({
    id: "t",
    surface_id: "s",
    role: "assistant",
    events,
  });
  it("uses the latest usage event and counts cached tokens as context", () => {
    const turns = [
      turn([{ kind: "usage", input_tokens: 1, output_tokens: 1 }]),
      turn([
        { kind: "assistant", text: "hi" },
        {
          kind: "usage",
          model: "m",
          input_tokens: 4,
          output_tokens: 9,
          cache_read_tokens: 1000,
          cache_creation_tokens: 50,
        },
      ]),
    ];
    const u = latestUsage(turns)!;
    expect(u.model).toBe("m");
    expect(contextTokens(u)).toBe(1054);
    expect(latestUsage([])).toBeNull();
  });

  it("formats token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(524891)).toBe("524.9k");
    expect(formatTokens(1250000)).toBe("1.25M");
  });
});
