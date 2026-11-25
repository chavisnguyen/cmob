import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";
import type { AppView } from "./navigation";

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
    const updatedWs = workspaces.find((w) => w.id === selectedWorkspace.id);
    if (updatedWs) {
      if (selectedSurface) {
        const updatedSurf = updatedWs.surfaces.find(
          (item) => item.id === selectedSurface.id || item.ref === selectedSurface.ref,
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
  mainTab: "workspaces" | "usage" | "devices";
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
