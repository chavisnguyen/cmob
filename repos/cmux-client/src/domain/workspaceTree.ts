import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";

export type AppView = "workspaces" | "surfaces" | "detail";
export type MainTab = "workspaces" | "usage" | "devices";

/** Stable surface identifier: prefers `id`, falls back to `ref`. */
export function surfaceIdentity(
  surface: Pick<SurfaceNode, "id" | "ref"> | null | undefined,
): string {
  if (!surface) return "";
  return surface.id || surface.ref;
}

/** True when `target` matches either `surface.id` or `surface.ref`. */
export function matchesSurfaceId(
  surface: Pick<SurfaceNode, "id" | "ref"> | null | undefined,
  target: string | null | undefined,
): boolean {
  if (!surface || !target) return false;
  return (
    (Boolean(surface.id) && surface.id === target) ||
    (Boolean(surface.ref) && surface.ref === target)
  );
}

export function sameSurface(a: SurfaceNode, b: SurfaceNode): boolean {
  if (
    a.id !== b.id ||
    a.ref !== b.ref ||
    a.title !== b.title ||
    a.surface_type !== b.surface_type ||
    a.tty !== b.tty ||
    a.selected !== b.selected ||
    a.focused !== b.focused
  ) {
    return false;
  }
  const aa = a.agent;
  const ba = b.agent;
  if (aa === ba) return true;
  if (!aa || !ba) return false;
  return (
    aa.agent_kind === ba.agent_kind &&
    aa.status === ba.status &&
    aa.session_id === ba.session_id &&
    aa.transcript_path === ba.transcript_path
  );
}

export function sameWorkspace(a: WorkspaceNode, b: WorkspaceNode): boolean {
  if (
    a.id !== b.id ||
    a.ref !== b.ref ||
    a.title !== b.title ||
    a.status !== b.status ||
    a.pinned !== b.pinned ||
    a.selected !== b.selected ||
    a.current_directory !== b.current_directory ||
    a.snippet !== b.snippet ||
    a.color !== b.color ||
    a.surfaces.length !== b.surfaces.length
  ) {
    return false;
  }
  for (let i = 0; i < a.surfaces.length; i += 1) {
    if (!sameSurface(a.surfaces[i], b.surfaces[i])) return false;
  }
  return true;
}

/**
 * Reconciles workspace snapshots from periodic polls, keeping identical object references intact
 * so downstream views and memoized components do not re-render when nothing changed.
 */
export function mergeWorkspaces(prev: WorkspaceNode[], next: WorkspaceNode[]): WorkspaceNode[] {
  if (prev.length === 0) return next;
  const byId = new Map(prev.map((w) => [w.id || w.ref, w]));
  let allSame = prev.length === next.length;
  const merged = next.map((ws, idx) => {
    const oldWs = byId.get(ws.id || ws.ref);
    if (!oldWs) {
      allSame = false;
      return ws;
    }
    if (sameWorkspace(oldWs, ws)) {
      if (prev[idx] !== oldWs) allSame = false;
      return oldWs;
    }
    allSame = false;
    const oldSurfById = new Map(oldWs.surfaces.map((s) => [surfaceIdentity(s), s]));
    const mergedSurfaces = ws.surfaces.map((s) => {
      const oldSurf = oldSurfById.get(surfaceIdentity(s));
      return oldSurf && sameSurface(oldSurf, s) ? oldSurf : s;
    });
    return { ...ws, surfaces: mergedSurfaces };
  });
  return allSame ? prev : merged;
}

/** Picks the workspace's active surface or falls back to the first tab. */
export function pickDefaultSurface(surfaces: SurfaceNode[]): SurfaceNode | null {
  if (surfaces.length === 0) return null;
  return surfaces.find((s) => s.selected) ?? surfaces[0] ?? null;
}

/** Picks the active workspace or falls back to the first one. */
export function pickDefaultWorkspace(workspaces: WorkspaceNode[]): WorkspaceNode | null {
  if (workspaces.length === 0) return null;
  return workspaces.find((w) => w.selected) ?? workspaces[0] ?? null;
}

export interface ReconcileSelectionInput {
  workspaces: WorkspaceNode[];
  selectedWorkspace: WorkspaceNode | null;
  selectedSurface: SurfaceNode | null;
  isDesktop: boolean;
  hasPendingJump: boolean;
}

export interface ReconcileSelectionResult {
  workspace: WorkspaceNode | null;
  surface: SurfaceNode | null;
  fallbackView: AppView | null;
}

/**
 * Reconciles selected workspace and surface after a workspace tree refresh or layout switch.
 * On desktop, ensures an active workspace and surface are chosen automatically unless a cold-start
 * deep link is pending.
 */
export function reconcileSelection({
  workspaces,
  selectedWorkspace,
  selectedSurface,
  isDesktop,
  hasPendingJump,
}: ReconcileSelectionInput): ReconcileSelectionResult {
  if (workspaces.length === 0) {
    return {
      workspace: null,
      surface: null,
      fallbackView: selectedWorkspace ? "workspaces" : null,
    };
  }

  if (selectedWorkspace) {
    const wsKey = selectedWorkspace.id || selectedWorkspace.ref;
    const updatedWs = workspaces.find(
      (w) => (w.id && w.id === wsKey) || (w.ref && w.ref === wsKey),
    );
    if (updatedWs) {
      if (selectedSurface) {
        const surfKey = surfaceIdentity(selectedSurface);
        const updatedSurf = updatedWs.surfaces.find(
          (item) =>
            matchesSurfaceId(item, selectedSurface.id) ||
            matchesSurfaceId(item, selectedSurface.ref) ||
            surfaceIdentity(item) === surfKey,
        );
        if (updatedSurf) {
          return { workspace: updatedWs, surface: updatedSurf, fallbackView: null };
        }
        const fallbackSurf = pickDefaultSurface(updatedWs.surfaces);
        return {
          workspace: updatedWs,
          surface: fallbackSurf,
          fallbackView: fallbackSurf ? null : "surfaces",
        };
      }
      const autoSurf = isDesktop ? pickDefaultSurface(updatedWs.surfaces) : null;
      return { workspace: updatedWs, surface: autoSurf, fallbackView: null };
    }
  }

  if (isDesktop && !hasPendingJump) {
    const nextWs = pickDefaultWorkspace(workspaces);
    const nextSurf = nextWs ? pickDefaultSurface(nextWs.surfaces) : null;
    return {
      workspace: nextWs,
      surface: nextSurf,
      fallbackView: nextSurf ? "detail" : nextWs ? "surfaces" : "workspaces",
    };
  }

  return {
    workspace: null,
    surface: null,
    fallbackView: selectedWorkspace ? "workspaces" : null,
  };
}

/**
 * Returns whether the user is actively viewing a surface so notifications and CLIENT_VIEWING stay
 * consistent across mobile single-pane and desktop multi-pane modes.
 */
export function computeIsViewingSurface({
  mainTab,
  selectedSurface,
  isDesktop,
  activeView,
}: {
  mainTab: MainTab;
  selectedSurface: SurfaceNode | null;
  isDesktop: boolean;
  activeView: AppView;
}): boolean {
  return (
    mainTab === "workspaces" && Boolean(selectedSurface) && (isDesktop || activeView === "detail")
  );
}

/** Derives the mobile screen matching the current selection when resizing across breakpoints. */
export function viewForSelection(
  selectedWorkspace: WorkspaceNode | null,
  selectedSurface: SurfaceNode | null,
): AppView {
  if (selectedSurface && selectedWorkspace) return "detail";
  if (selectedWorkspace) return "surfaces";
  return "workspaces";
}
