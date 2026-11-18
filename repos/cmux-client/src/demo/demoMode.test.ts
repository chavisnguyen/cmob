import { describe, it, expect, beforeEach } from "vite-plus/test";
import { isDemoMode, handleDemoRpc, resetDemoState } from "./demoMode";
import { RPC_METHODS } from "../protocol/rpc";
import type { WorkspaceNode } from "../protocol/rpc";
import type { AgentTurn } from "../protocol/event";

describe("demoMode", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("identifies demo mode when query parameter is present", () => {
    expect(typeof isDemoMode()).toBe("boolean");
  });

  it("returns workspaces for active host", async () => {
    const res = await handleDemoRpc<{ workspaces: WorkspaceNode[] }>(RPC_METHODS.WORKSPACE_TREE);
    expect(res.workspaces).toBeDefined();
    expect(res.workspaces.length).toBeGreaterThan(0);
    expect(res.workspaces[0].title).toBe("cmux-mobile");
  });

  it("handles Claude chat turns and approval transition", async () => {
    const initial = await handleDemoRpc<{ turns: AgentTurn[]; awaiting_prompt: string | null }>(
      RPC_METHODS.CHAT_READ_SESSION,
      { surface_id: "surf-claude" },
    );
    expect(initial.turns.length).toBe(2);
    expect(initial.awaiting_prompt).toContain("Allow Claude to execute bash command");

    // Approve
    const approveRes = await handleDemoRpc<{ ok: boolean }>(RPC_METHODS.CHAT_APPROVE, {
      surface_id: "surf-claude",
    });
    expect(approveRes.ok).toBe(true);

    const approved = await handleDemoRpc<{ turns: AgentTurn[]; awaiting_prompt: string | null }>(
      RPC_METHODS.CHAT_READ_SESSION,
      { surface_id: "surf-claude" },
    );
    expect(approved.awaiting_prompt).toBeNull();
    const lastTurn = approved.turns[approved.turns.length - 1];
    expect(
      lastTurn.events.some((e) => e.kind === "assistant" && e.text.includes("Permission granted")),
    ).toBe(true);
  });

  it("returns terminal replay data", async () => {
    const res = await handleDemoRpc<any>(RPC_METHODS.TERMINAL_REPLAY, { surface_id: "surf-term" });
    expect(res.render_grid).toBeDefined();
    expect(res.render_grid.columns).toBe(80);
    expect(res.render_grid.rows).toBe(24);
  });
});
