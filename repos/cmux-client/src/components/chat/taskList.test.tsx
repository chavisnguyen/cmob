import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { AgentTurn } from "../../protocol/event";
import { MobileNativeChatBackgroundTasksCard } from "./MobileNativeChatBackgroundTasksCard";
import { MobileNativeChatComposerTray } from "./MobileNativeChatComposerTray";
import { MobileNativeChatToolRun } from "./MobileNativeChatToolRun";
import { deriveConversationTasks, parseSnapshotTaskList } from "./taskList";

describe("multi-agent taskList & background work normalization", () => {
  it("parses Claude TodoWrite, OpenCode todowrite, Codex update_plan, and Antigravity update_steps", () => {
    const claude = parseSnapshotTaskList(
      "TodoWrite",
      JSON.stringify({
        todos: [
          { content: "Inspect protocol", status: "completed" },
          {
            content: "Build tray UI",
            status: "in_progress",
            activeForm: "Building tray UI…",
          },
        ],
      }),
    );
    expect(claude?.tasks).toHaveLength(2);
    expect(claude?.tasks[1]).toMatchObject({
      content: "Build tray UI",
      status: "in_progress",
      activeForm: "Building tray UI…",
    });

    const codex = parseSnapshotTaskList(
      "update_plan",
      JSON.stringify({
        explanation: "Two-phase rollout",
        plan: [
          { step: "Phase 1", status: "completed" },
          { step: "Phase 2", status: "inProgress" },
        ],
      }),
    );
    expect(codex?.explanation).toBe("Two-phase rollout");
    expect(codex?.tasks[1].status).toBe("in_progress");

    // Antigravity (`agy`) encodes `steps` as a stringified JSON array inside `args`
    const agy = parseSnapshotTaskList(
      "update_steps",
      JSON.stringify({
        steps: JSON.stringify([
          { status: "done", title: "Parse compaction events" },
          { status: "in_progress", title: "Render centered divider" },
          { status: "pending", title: "Run tests" },
        ]),
      }),
    );
    expect(agy?.tasks).toEqual([
      { content: "Parse compaction events", status: "completed" },
      { content: "Render centered divider", status: "in_progress" },
      { content: "Run tests", status: "pending" },
    ]);
  });

  it("reduces Claude 2.1 TaskCreate and TaskUpdate calls into docked checklist state", () => {
    const turns: AgentTurn[] = [
      {
        id: "t-1",
        surface_id: "s-1",
        role: "assistant",
        events: [
          {
            kind: "tool-start",
            tool_id: "tc-1",
            name: "TaskCreate",
            detail: JSON.stringify({ subject: "Audit socket", status: "pending" }),
          },
          { kind: "tool-end", tool_id: "tc-1", detail: "Created Task #1", ok: true },
          {
            kind: "tool-start",
            tool_id: "tc-2",
            name: "TaskCreate",
            detail: JSON.stringify({ subject: "Write tests", status: "pending" }),
          },
          { kind: "tool-end", tool_id: "tc-2", detail: "Created Task #2", ok: true },
          {
            kind: "tool-start",
            tool_id: "tu-1",
            name: "TaskUpdate",
            detail: JSON.stringify({ taskId: "1", status: "completed" }),
          },
          { kind: "tool-end", tool_id: "tu-1", ok: true },
          {
            kind: "tool-start",
            tool_id: "tu-2",
            name: "TaskUpdate",
            detail: JSON.stringify({ taskId: "2", status: "in_progress" }),
          },
          { kind: "tool-end", tool_id: "tu-2", ok: true },
        ],
      },
    ];

    const snapshot = deriveConversationTasks(turns, true);
    expect(snapshot.dockedTaskList?.tasks).toEqual([
      { id: "1", content: "Audit socket", status: "completed" },
      { id: "2", content: "Write tests", status: "in_progress" },
    ]);
  });

  it("derives active subagents and background shell jobs and renders ComposerTray + cards", () => {
    const turns: AgentTurn[] = [
      {
        id: "t-ast",
        surface_id: "s-1",
        role: "assistant",
        timestamp: 1_700_000_000_000,
        events: [
          {
            kind: "tool-start",
            tool_id: "agy-steps",
            name: "update_steps",
            detail: JSON.stringify({
              steps: JSON.stringify([
                { status: "done", title: "Step A" },
                { status: "in_progress", title: "Step B" },
              ]),
            }),
          },
          { kind: "tool-end", tool_id: "agy-steps", detail: "OK", ok: true },
          {
            kind: "subagents",
            group_id: "g-1",
            agents: [
              {
                id: "a-1",
                label: "Protocol Researcher",
                state: "working",
                tokens: 14200,
                started_at: 1_700_000_000_000,
              },
              {
                id: "a-2",
                label: "UI Verifier",
                state: "completed",
                tokens: 8100,
                started_at: 1_700_000_000_000,
                settled_at: 1_700_000_005_000,
              },
            ],
          },
          {
            kind: "background-tasks",
            tasks: [
              {
                id: "task-1620",
                kind: "command",
                label: "Gateway test suite",
                state: "working",
                started_at: 1_700_000_001_000,
              },
            ],
          },
        ],
      },
    ];

    const derived = deriveConversationTasks(turns, true);
    expect(derived.dockedTaskList?.tasks).toHaveLength(2);
    expect(derived.backgroundWork?.hasLiveWork).toBe(true);
    expect(derived.backgroundWork?.groups).toHaveLength(2);

    const trayHtml = renderToStaticMarkup(
      <MobileNativeChatComposerTray
        taskList={derived.dockedTaskList}
        backgroundWork={derived.backgroundWork}
        scopeKey="surf-test"
      />,
    );
    expect(trayHtml).toContain('data-testid="docked-task-list"');
    expect(trayHtml).toContain("Step B");
    expect(trayHtml).toContain("1/2");
    expect(trayHtml).toContain('data-testid="background-tasks-strip"');
    expect(trayHtml).toContain("2 subagents");
    expect(trayHtml).toContain("1 shell job");

    const bgCardHtml = renderToStaticMarkup(
      <MobileNativeChatBackgroundTasksCard
        tasks={[
          {
            id: "task-1620",
            kind: "command",
            label: "Gateway test suite",
            state: "working",
            started_at: 1_700_000_001_000,
          },
        ]}
      />,
    );
    expect(bgCardHtml).toContain("Gateway test suite");
    expect(bgCardHtml).toContain("running");

    // Verify tool run preserves inputDetail even after ToolEnd overwrites detail with "OK".
    const toolRunHtml = renderToStaticMarkup(
      <MobileNativeChatToolRun
        tools={[
          {
            id: "agy-steps",
            name: "update_steps",
            inputDetail: JSON.stringify({
              steps: JSON.stringify([
                { status: "done", title: "Step A" },
                { status: "in_progress", title: "Step B" },
              ]),
            }),
            detail: "OK",
            ok: true,
            isEnd: true,
          },
        ]}
      />,
    );
    expect(toolRunHtml).toContain("Step B (1/2)");
  });
});
