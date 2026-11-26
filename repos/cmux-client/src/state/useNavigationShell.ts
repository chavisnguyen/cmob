import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeIsViewingSurface,
  matchesSurfaceId,
  pickDefaultSurface,
  reconcileSelection,
  surfaceIdentity,
  viewForSelection,
  type AppView,
  type MainTab,
} from "../domain/workspaceTree";
import {
  goBack,
  pushView,
  replaceView,
  showDetailEntry,
  useHistoryNavigation,
} from "../native/navigation";
import type { SurfaceNode, WorkspaceNode } from "../protocol/rpc";

export function useNavigationShell({
  isDesktop,
  initialWorkspaces,
}: {
  isDesktop: boolean;
  initialWorkspaces: WorkspaceNode[];
}) {
  const [mainTab, setMainTab] = useState<MainTab>("workspaces");
  const [activeView, setActiveView] = useState<AppView>("workspaces");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const initialReconciled =
    isDesktop && initialWorkspaces.length > 0
      ? reconcileSelection({
          workspaces: initialWorkspaces,
          selectedWorkspace: null,
          selectedSurface: null,
          isDesktop: true,
          hasPendingJump: false,
        })
      : { workspace: null, surface: null };

  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceNode | null>(
    initialReconciled.workspace,
  );
  const [selectedSurface, setSelectedSurface] = useState<SurfaceNode | null>(
    initialReconciled.surface,
  );

  const selectedWorkspaceRef = useRef(selectedWorkspace);
  const selectedSurfaceRef = useRef(selectedSurface);
  const activeViewRef = useRef(activeView);
  const isDesktopRef = useRef(isDesktop);
  const mainTabRef = useRef(mainTab);
  const prevIsDesktopRef = useRef(isDesktop);

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    selectedSurfaceRef.current = selectedSurface;
  }, [selectedSurface]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    mainTabRef.current = mainTab;
  }, [mainTab]);

  const reconcileWithWorkspaces = useCallback(
    (workspaces: WorkspaceNode[], hasPendingJump: boolean) => {
      const reconciled = reconcileSelection({
        workspaces,
        selectedWorkspace: selectedWorkspaceRef.current,
        selectedSurface: selectedSurfaceRef.current,
        isDesktop: isDesktopRef.current,
        hasPendingJump,
      });
      if (reconciled.workspace !== selectedWorkspaceRef.current) {
        selectedWorkspaceRef.current = reconciled.workspace;
        setSelectedWorkspace(reconciled.workspace);
      }
      if (reconciled.surface !== selectedSurfaceRef.current) {
        selectedSurfaceRef.current = reconciled.surface;
        setSelectedSurface(reconciled.surface);
      }
      if (reconciled.fallbackView && !isDesktopRef.current) {
        setActiveView(reconciled.fallbackView);
      }
    },
    [],
  );

  // Sync selection & browser history stack when resizing across Desktop <-> Mobile breakpoints.
  const syncBreakpoint = useCallback(
    (workspaces: WorkspaceNode[], hasPendingJump: boolean) => {
      const wasDesktop = prevIsDesktopRef.current;
      prevIsDesktopRef.current = isDesktop;
      isDesktopRef.current = isDesktop;

      if (isDesktop) {
        if (workspaces.length > 0) {
          reconcileWithWorkspaces(workspaces, hasPendingJump);
        }
        return;
      }

      const nextView = viewForSelection(selectedWorkspaceRef.current, selectedSurfaceRef.current);
      setActiveView(nextView);
      if (wasDesktop && typeof window !== "undefined") {
        if (nextView === "detail") {
          showDetailEntry();
        } else if (nextView === "surfaces") {
          pushView("surfaces");
        }
      }
    },
    [isDesktop, reconcileWithWorkspaces],
  );

  const handlePop = useCallback((view: AppView) => {
    if (mainTabRef.current !== "workspaces") {
      setMainTab("workspaces");
      return;
    }
    if (isDesktopRef.current) return;

    if (view === "workspaces") {
      setActiveView("workspaces");
      setSelectedWorkspace(null);
      setSelectedSurface(null);
    } else if (view === "surfaces") {
      setActiveView(selectedWorkspaceRef.current ? "surfaces" : "workspaces");
      setSelectedSurface(null);
    } else {
      setActiveView(selectedSurfaceRef.current ? "detail" : "surfaces");
    }
  }, []);
  useHistoryNavigation(handlePop);

  const jumpToSurfaceInList = useCallback(
    (workspaces: readonly WorkspaceNode[], targetSurfaceId: string): SurfaceNode | null => {
      for (const ws of workspaces) {
        const match = ws.surfaces.find((s) => matchesSurfaceId(s, targetSurfaceId));
        if (match) {
          setMainTab("workspaces");
          selectedWorkspaceRef.current = ws;
          selectedSurfaceRef.current = match;
          setSelectedWorkspace(ws);
          setSelectedSurface(match);
          setActiveView("detail");
          if (!isDesktopRef.current) {
            showDetailEntry();
          }
          return match;
        }
      }
      return null;
    },
    [],
  );

  const selectWorkspace = useCallback(
    (ws: WorkspaceNode) => {
      setMainTab("workspaces");
      selectedWorkspaceRef.current = ws;
      setSelectedWorkspace(ws);
      if (isDesktop) {
        const surf = pickDefaultSurface(ws.surfaces);
        selectedSurfaceRef.current = surf;
        setSelectedSurface(surf);
        setActiveView("detail");
        return;
      }
      setActiveView("surfaces");
      pushView("surfaces");
    },
    [isDesktop],
  );

  const selectSurface = useCallback(
    (surf: SurfaceNode) => {
      setMainTab("workspaces");
      selectedSurfaceRef.current = surf;
      setSelectedSurface(surf);
      if (!isDesktop) {
        showDetailEntry();
      }
      setActiveView("detail");
    },
    [isDesktop],
  );

  const backToWorkspaces = useCallback(() => {
    goBack(() => {
      setActiveView("workspaces");
      setSelectedWorkspace(null);
      setSelectedSurface(null);
    });
  }, []);

  const backToSurfaces = useCallback(() => {
    if (isDesktop) {
      setSelectedSurface(null);
      return;
    }
    goBack(() => {
      setActiveView("surfaces");
      setSelectedSurface(null);
    });
  }, [isDesktop]);

  const resetNavigation = useCallback(() => {
    selectedWorkspaceRef.current = null;
    selectedSurfaceRef.current = null;
    setSelectedWorkspace(null);
    setSelectedSurface(null);
    setActiveView("workspaces");
    if (!isDesktopRef.current && typeof window !== "undefined") {
      replaceView("workspaces");
    }
  }, []);

  const isViewingSurface = computeIsViewingSurface({
    mainTab,
    selectedSurface,
    isDesktop,
    activeView,
  });

  const viewingSurfaceId = surfaceIdentity(selectedSurface) || null;

  return {
    mainTab,
    setMainTab,
    activeView,
    sidebarCollapsed,
    setSidebarCollapsed,
    selectedWorkspace,
    selectedWorkspaceRef,
    selectedSurface,
    selectedSurfaceRef,
    isViewingSurface,
    viewingSurfaceId,
    reconcileWithWorkspaces,
    syncBreakpoint,
    jumpToSurfaceInList,
    selectWorkspace,
    selectSurface,
    backToWorkspaces,
    backToSurfaces,
    resetNavigation,
  };
}
