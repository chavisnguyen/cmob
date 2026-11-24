import { describe, expect, it } from "vite-plus/test";
import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";
import {
  computeIsViewingSurface,
  pickDefaultSurface,
  pickDefaultWorkspace,
  reconcileSelection,
  viewForSelection,
} from "./desktopState";

const surf = (id: string, selected = false): SurfaceNode => ({
  id,
  ref: `ref:${id}`,
  title: id,
  surface_type: "terminal",
  selected,
  focused: selected,
});

const ws = (id: string, surfaces: SurfaceNode[], selected = false): WorkspaceNode => ({
  id,
  ref: `ws:${id}`,
  title: id,
  status: "idle",
  pinned: false,
  selected,
  current_directory: "/tmp",
  surfaces,
});

describe("desktopState", () => {
  it("picks selected surface/workspace first and falls back to index 0", () => {
    const s1 = surf("s1");
    const s2 = surf("s2", true);
    expect(pickDefaultSurface([s1, s2])?.id).toBe("s2");
    expect(pickDefaultSurface([s1])?.id).toBe("s1");
    expect(pickDefaultSurface([])).toBeNull();

    const w1 = ws("w1", [s1]);
    const w2 = ws("w2", [s2], true);
    expect(pickDefaultWorkspace([w1, w2])?.id).toBe("w2");
    expect(pickDefaultWorkspace([w1])?.id).toBe("w1");
    expect(pickDefaultWorkspace([])).toBeNull();
  });

  it("auto-selects default workspace and surface on desktop when nothing is selected", () => {
    const w1 = ws("w1", [surf("s1")]);
    const w2 = ws("w2", [surf("s2"), surf("s3", true)], true);
    const res = reconcileSelection({
      workspaces: [w1, w2],
      selectedWorkspace: null,
      selectedSurface: null,
      isDesktop: true,
      hasPendingJump: false,
    });
    expect(res.workspace?.id).toBe("w2");
    expect(res.surface?.id).toBe("s3");
  });

  it("defers auto-selection on desktop while a cold-start surface jump is pending", () => {
    const w1 = ws("w1", [surf("s1")], true);
    const res = reconcileSelection({
      workspaces: [w1],
      selectedWorkspace: null,
      selectedSurface: null,
      isDesktop: true,
      hasPendingJump: true,
    });
    expect(res.workspace).toBeNull();
    expect(res.surface).toBeNull();
  });

  it("falls back when the previously selected workspace disappears", () => {
    const gone = ws("gone", [surf("old")]);
    const remaining = ws("rem", [surf("r1")]);

    const desktopRes = reconcileSelection({
      workspaces: [remaining],
      selectedWorkspace: gone,
      selectedSurface: surf("old"),
      isDesktop: true,
      hasPendingJump: false,
    });
    expect(desktopRes.workspace?.id).toBe("rem");
    expect(desktopRes.surface?.id).toBe("r1");

    const mobileRes = reconcileSelection({
      workspaces: [remaining],
      selectedWorkspace: gone,
      selectedSurface: surf("old"),
      isDesktop: false,
      hasPendingJump: false,
    });
    expect(mobileRes.workspace).toBeNull();
    expect(mobileRes.surface).toBeNull();
    expect(mobileRes.fallbackView).toBe("workspaces");
  });

  it("computes viewing state consistently for desktop and mobile", () => {
    const s = surf("s1");
    expect(
      computeIsViewingSurface({
        mainTab: "workspaces",
        selectedSurface: s,
        isDesktop: true,
        activeView: "workspaces",
      }),
    ).toBe(true);
    expect(
      computeIsViewingSurface({
        mainTab: "devices",
        selectedSurface: s,
        isDesktop: true,
        activeView: "detail",
      }),
    ).toBe(false);
    expect(
      computeIsViewingSurface({
        mainTab: "workspaces",
        selectedSurface: s,
        isDesktop: false,
        activeView: "surfaces",
      }),
    ).toBe(false);
  });

  it("maps selection back to mobile AppView cleanly", () => {
    const w = ws("w1", [surf("s1")]);
    expect(viewForSelection(w, surf("s1"))).toBe("detail");
    expect(viewForSelection(w, null)).toBe("surfaces");
    expect(viewForSelection(null, null)).toBe("workspaces");
  });
});
