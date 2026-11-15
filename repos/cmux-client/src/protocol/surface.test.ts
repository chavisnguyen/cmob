import { describe, expect, it } from "vite-plus/test";
import { createRpcRequest, RPC_METHODS, type SurfaceNode } from "./rpc";

describe("Surface Management Protocol & Model Tests", () => {
  it("formats mobile.surface.new RPC request without split direction", () => {
    const req = createRpcRequest(
      RPC_METHODS.SURFACE_NEW,
      {
        workspace_id: "ws-primary",
        command: "claude",
      },
      "req-new-surface",
    );

    expect(req).toEqual({
      id: "req-new-surface",
      method: "mobile.surface.new",
      params: {
        workspace_id: "ws-primary",
        command: "claude",
      },
    });
  });

  it("formats mobile.surface.rename RPC request correctly", () => {
    const req = createRpcRequest(
      RPC_METHODS.SURFACE_RENAME,
      {
        surface_id: "surface:14",
        title: "build logs",
      },
      "req-rename-surface",
    );

    expect(req).toEqual({
      id: "req-rename-surface",
      method: "mobile.surface.rename",
      params: {
        surface_id: "surface:14",
        title: "build logs",
      },
    });
  });

  it("formats mobile.surface.close RPC request with force=true", () => {
    const req = createRpcRequest(
      RPC_METHODS.SURFACE_CLOSE,
      {
        surface_id: "surface:14",
        force: true,
      },
      "req-close-surface",
    );

    expect(req).toEqual({
      id: "req-close-surface",
      method: "mobile.surface.close",
      params: {
        surface_id: "surface:14",
        force: true,
      },
    });
  });

  it("projects active surface and computes switcher tab state", () => {
    const surfaces: SurfaceNode[] = [
      {
        id: "surf-1",
        ref: "surf-1",
        title: "Main Terminal",
        surface_type: "terminal",
        selected: false,
        focused: false,
      },
      {
        id: "surf-2",
        ref: "surf-2",
        title: "Claude Agent",
        surface_type: "terminal",
        selected: true,
        focused: true,
        agent: {
          agent_kind: "claude",
          status: "waiting",
          session_id: "sess-claude",
        },
      },
      {
        id: "surf-3",
        ref: "surf-3",
        title: "AGY Agent",
        surface_type: "terminal",
        selected: false,
        focused: false,
        agent: {
          agent_kind: "antigravity",
          status: "running",
          session_id: "sess-agy",
        },
      },
    ];

    const activeId = "surf-2";
    const activeSurface = surfaces.find((item) => (item.id || item.ref) === activeId);
    expect(activeSurface?.title).toBe("Claude Agent");
    expect(activeSurface?.agent?.agent_kind).toBe("claude");
    expect(activeSurface?.agent?.status).toBe("waiting");

    const nextActiveId = "surf-3";
    const nextActiveSurface = surfaces.find((item) => (item.id || item.ref) === nextActiveId);
    expect(nextActiveSurface?.title).toBe("AGY Agent");
    expect(nextActiveSurface?.agent?.status).toBe("running");

    const remaining = surfaces.filter((item) => (item.id || item.ref) !== "surf-2");
    expect(remaining.length).toBe(2);
    expect(remaining[0].id).toBe("surf-1");
    expect(remaining[1].id).toBe("surf-3");
  });
});
