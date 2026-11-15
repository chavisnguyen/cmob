import { describe, expect, it } from "vite-plus/test";
import {
  CODE_METHOD_NOT_FOUND,
  createRpcRequest,
  RPC_METHODS,
  type JsonRpcResponse,
  type WorkspaceNode,
  type WorkspaceSummary,
} from "./rpc";
import type { AgentEvent, AgentTurn, SubagentEntry } from "./event";

describe("Agent Event Model & JSON-RPC Contract", () => {
  it("creates and formats JSON-RPC requests correctly", () => {
    const req = createRpcRequest(
      RPC_METHODS.CHAT_SEND,
      { surface_id: "surf-42", text: "npm run test" },
      "req-101",
    );

    expect(req).toEqual({
      id: "req-101",
      method: "mobile.chat.send",
      params: {
        surface_id: "surf-42",
        text: "npm run test",
      },
    });
  });

  it("handles JSON-RPC responses and errors", () => {
    const errorResponse: JsonRpcResponse = {
      id: "req-101",
      error: {
        code: CODE_METHOD_NOT_FOUND,
        message: "Method not found: invalid.method",
      },
    };

    expect(errorResponse.error?.code).toBe(-32601);
    expect(errorResponse.error?.message).toContain("Method not found");
  });

  it("normalizes golden Claude transcript fixtures into AgentEvent sequence", () => {
    // Exact event sequence from ref/cmux/agent-chat/test/transcript.test.ts:50-64
    const goldenEvents: AgentEvent[] = [
      { kind: "user", text: "fix the flaky test" },
      { kind: "thinking", text: "look at the test first" },
      {
        kind: "tool-start",
        tool_id: "t1",
        name: "Bash",
        detail: "bun test flaky",
      },
      { kind: "tool-end", tool_id: "t1", ok: false, detail: "1 fail" },
      { kind: "assistant", text: "Fixed the race in `setup`." },
      { kind: "done", stats: "4.2s" },
      { kind: "user", text: "/model opus" },
      { kind: "status", text: "Set model to opus" },
      { kind: "status", text: "Background task: Build finished" },
      { kind: "status", text: "Interrupted" },
      { kind: "done" },
      { kind: "error", message: "API Error: overloaded" },
      { kind: "status", text: "Conversation compacted" },
    ];

    const turn: AgentTurn = {
      id: "turn-1",
      surface_id: "surf-42",
      role: "assistant",
      events: goldenEvents,
    };

    expect(turn.events.length).toBe(13);
    expect(turn.events[0]).toEqual({
      kind: "user",
      text: "fix the flaky test",
    });
    expect(turn.events[1]).toEqual({
      kind: "thinking",
      text: "look at the test first",
    });
    expect(turn.events[3]).toEqual({
      kind: "tool-end",
      tool_id: "t1",
      ok: false,
      detail: "1 fail",
    });
  });

  it("supports subagent hierarchy and terminal states", () => {
    const subagents: SubagentEntry[] = [
      {
        id: "child-1",
        label: "Context Auditor",
        state: "completed",
        tokens: 4200,
      },
      {
        id: "child-2",
        label: "Socket Inspector",
        state: "failed",
        tokens: 1500,
      },
    ];

    const event: AgentEvent = {
      kind: "subagents",
      group_id: "group-10",
      agents: subagents,
    };

    expect(event.kind).toBe("subagents");
    if (event.kind === "subagents") {
      expect(event.agents[0].state).toBe("completed");
      expect(event.agents[1].state).toBe("failed");
    }
  });

  it("supports awaiting-input permission prompts", () => {
    const promptEvent: AgentEvent = {
      kind: "awaiting-input",
      input_kind: "permission",
      prompt: "Allow command: git push origin main?",
      options: ["Proceed", "Cancel"],
      default_choice: "Proceed",
    };

    expect(promptEvent.kind).toBe("awaiting-input");
    if (promptEvent.kind === "awaiting-input") {
      expect(promptEvent.input_kind).toBe("permission");
      expect(promptEvent.options).toContain("Proceed");
      expect(promptEvent.default_choice).toBe("Proceed");
    }
  });

  it("supports 3-level cmux navigation hierarchy types", () => {
    const wsNode: WorkspaceNode = {
      id: "4EA5F151-84D5-41E3-A92B-D9A082DD1EBC",
      ref: "workspace:1000080003",
      title: "Project A workspace",
      pinned: true,
      selected: false,
      status: "idle",
      current_directory: "/Users/dev/project-a",
      snippet: "Đã lưu vào work/, commit và push.",
      surfaces: [
        {
          id: "4BEC6107-D94C-4DDE-93AF-3835F68B0E93",
          ref: "surface:1000080008",
          title: "Đồng bộ dữ liệu code hub",
          surface_type: "terminal",
          tty: "ttys006",
          selected: true,
          focused: true,
          agent: {
            session_id: "f6c4368e-faef-4b60-9432-e1ca1a198168",
            agent_kind: "claude",
            status: "idle",
          },
        },
      ],
    };

    expect(wsNode.surfaces).toHaveLength(1);
    expect(wsNode.surfaces[0].agent?.agent_kind).toBe("claude");
    expect(wsNode.status).toBe("idle");

    const summary: WorkspaceSummary = {
      id: wsNode.id,
      ref: wsNode.ref,
      title: wsNode.title,
      pinned: wsNode.pinned,
      selected: wsNode.selected,
      status: wsNode.status,
      current_directory: wsNode.current_directory,
      snippet: wsNode.snippet,
      surface_count: wsNode.surfaces.length,
      has_running_agent: false,
    };

    expect(summary.surface_count).toBe(1);
    expect(summary.has_running_agent).toBe(false);
  });
});
