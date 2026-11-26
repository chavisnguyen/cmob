import { useCallback, useEffect, useRef, useState } from "react";
import { Share2, X } from "lucide-react";
import { AppModals } from "./components/shell/AppModals";
import { AppTopHeader } from "./components/shell/AppTopHeader";
import { DesktopWorkspaceShell } from "./components/shell/DesktopWorkspaceShell";
import { MobileWorkspaceShell } from "./components/shell/MobileWorkspaceShell";
import { useUsageSnapshot } from "./components/usage/useUsageSnapshot";
import { INITIAL_TURN_PAGE_SIZE } from "./domain/chat/transcriptReducer";
import { totalUnreadNotifications } from "./domain/workspaceTree";
import { peekCachedWorkspaces } from "./hosts/workspaceCache";
import { installGlobalButtonHaptics } from "./native/haptics";
import { useIsDesktop } from "./native/useMediaQuery";
import { useVisualViewportVars } from "./native/useVisualViewportVars";
import type { SurfaceNode, WorkspaceNode } from "./protocol/rpc";
import { useHostSession } from "./state/useHostSession";
import { useNavigationShell } from "./state/useNavigationShell";
import { useNotificationController } from "./state/useNotificationController";
import { useWorkspaceStore } from "./state/useWorkspaceStore";
import { wsClient } from "./transport/wsClient";

export function App() {
  const isDesktop = useIsDesktop();
  useVisualViewportVars();
  useEffect(() => installGlobalButtonHaptics(), []);
  // Warm the chat markdown chunk right after first paint so opening any agent tab is instant.
  useEffect(() => {
    const timer = setTimeout(() => {
      void import("./components/chat/OrcaChatView");
    }, 120);
    return () => clearTimeout(timer);
  }, []);

  const [sidebarNewWs, setSidebarNewWs] = useState<WorkspaceNode | null>(null);
  const [sidebarCloseTarget, setSidebarCloseTarget] = useState<{
    ws: WorkspaceNode;
    surface: SurfaceNode;
  } | null>(null);
  const [changesWs, setChangesWs] = useState<WorkspaceNode | null>(null);
  const [initialWorkspaces] = useState<WorkspaceNode[]>(() =>
    peekCachedWorkspaces(wsClient.getEndpoint()),
  );

  const nav = useNavigationShell({ isDesktop, initialWorkspaces });

  // Register 1-RTT WebSocket auth bootstrap hint BEFORE `useHostSession` opens the socket.
  const isDesktopBootRef = useRef(isDesktop);
  const viewingBootRef = useRef(nav.viewingSurfaceId);
  isDesktopBootRef.current = isDesktop;
  viewingBootRef.current = nav.viewingSurfaceId;
  wsClient.setBootstrapProvider(() => {
    const urlSurface =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("surface")
        : null;
    const targetSurface = urlSurface || viewingBootRef.current || undefined;
    return {
      workspace_tree: true,
      ...(targetSurface ? { surface_id: targetSurface } : {}),
      is_desktop: isDesktopBootRef.current,
      max_turns: INITIAL_TURN_PAGE_SIZE,
      delta: true,
    };
  });

  const dismissToastsForSurfaceRef = useRef<(surface: SurfaceNode | string) => void>(() => {});
  const clearAllToastsRef = useRef<() => void>(() => {});
  const resetWorkspacesRef = useRef<(nextEndpoint?: string | null) => void>(() => {});
  const fetchWorkspacesRef = useRef<(showSpinner?: boolean) => Promise<void>>(async () => {});
  const workspacesListRef = useRef<WorkspaceNode[]>(initialWorkspaces);

  const handleJumpToSurface = useCallback(
    (targetSurfaceId: string): boolean => {
      const matched = nav.jumpToSurfaceInList(workspacesListRef.current, targetSurfaceId);
      if (matched) {
        dismissToastsForSurfaceRef.current(matched);
        return true;
      }
      return false;
    },
    [nav],
  );

  const resetForHostChange = useCallback(
    (nextEndpoint?: string | null) => {
      nav.resetNavigation();
      resetWorkspacesRef.current(nextEndpoint);
      setChangesWs(null);
      setSidebarNewWs(null);
      setSidebarCloseTarget(null);
      clearAllToastsRef.current();
    },
    [nav],
  );

  const hostSession = useHostSession({
    onResetForHostChange: resetForHostChange,
    onConnectedHostReady: () => void fetchWorkspacesRef.current(false),
  });

  const {
    workspaces,
    workspacesRef,
    loading,
    syncing,
    hasPendingSurfaceJump,
    fetchWorkspaces,
    resetWorkspacesForHost,
    markSurfaceRead,
    createSurface,
    renameSurface,
    closeSurface,
  } = useWorkspaceStore({
    connState: hostSession.connState,
    onWorkspacesReconcile: nav.reconcileWithWorkspaces,
    onJumpToSurface: handleJumpToSurface,
  });

  useEffect(() => {
    workspacesListRef.current = workspaces;
    resetWorkspacesRef.current = resetWorkspacesForHost;
    fetchWorkspacesRef.current = fetchWorkspaces;
  }, [workspaces, resetWorkspacesForHost, fetchWorkspaces]);

  useEffect(() => {
    if (nav.isViewingSurface && nav.selectedSurface) {
      markSurfaceRead(nav.selectedSurface);
    }
  }, [nav.isViewingSurface, nav.selectedSurface, workspaces, markSurfaceRead]);

  const { syncBreakpoint } = nav;
  useEffect(() => {
    syncBreakpoint(workspaces, hasPendingSurfaceJump());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, syncBreakpoint, hasPendingSurfaceJump]);

  const notifs = useNotificationController({
    connState: hostSession.connState,
    workspaces,
    workspacesRef,
    selectedSurface: nav.selectedSurface,
    isViewingSurface: nav.isViewingSurface,
    viewingSurfaceId: nav.viewingSurfaceId,
    onJumpToSurface: (surfaceId) => void handleJumpToSurface(surfaceId),
    onNotificationStateChange: () => void fetchWorkspaces(false),
  });

  useEffect(() => {
    dismissToastsForSurfaceRef.current = notifs.dismissToastsForSurface;
    clearAllToastsRef.current = notifs.clearAllToasts;
  }, [notifs.dismissToastsForSurface, notifs.clearAllToasts]);

  const usageState = useUsageSnapshot({
    enabled: isDesktop || nav.mainTab === "usage",
    connState: hostSession.connState,
    hostKey: hostSession.activeHostId || hostSession.activeHost?.endpoint || "",
    pollMs: nav.mainTab === "usage" ? 30_000 : 60_000,
    trackAgeTick: nav.mainTab === "usage",
  });

  const isConnecting =
    hostSession.connState === "connecting" || hostSession.connState === "authenticating";
  const hasNoHosts =
    hostSession.hosts.length === 0 && hostSession.connState !== "connected" && !isConnecting;
  const errorMessage = wsClient.getLastErrorMessage();
  const totalUnread = totalUnreadNotifications(workspaces);

  const topBrandHeader = (
    <AppTopHeader
      connState={hostSession.connState}
      activeHost={hostSession.activeHost}
      notifPermission={notifs.notifPermission}
      compactTopInset={notifs.showIosPwaBanner || isDesktop}
      onOpenHostSheet={() => hostSession.setShowHostSheet(true)}
      onToggleNotifications={() => void notifs.handleToggleNotifications()}
      onOpenPairModal={() => hostSession.setShowPairModal(true)}
      onSelectMainTab={nav.setMainTab}
      onOpenTokenModal={() => hostSession.setShowTokenModal(true)}
    />
  );

  return (
    <div className="flex flex-col h-full w-full max-w-full overflow-hidden bg-bg font-sans antialiased select-none lg:select-text">
      {notifs.showIosPwaBanner && (
        <div className="flex items-center justify-between gap-2 px-4 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-2 bg-bg border-b border-white/[0.08] text-[13px] text-fg-soft shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-accent-soft shrink-0" />
            <span className="leading-snug">
              Tap Share then &apos;Add to Home Screen&apos; to enable PWA lock-screen push.
            </span>
          </div>
          <button
            type="button"
            onClick={() => notifs.setShowIosPwaBanner(false)}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-muted hover:text-white flex items-center justify-center shrink-0"
            aria-label="Dismiss banner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!isDesktop && nav.activeView !== "detail" && (
        <div className="flex flex-col shrink-0 z-30">
          {topBrandHeader}
          {hostSession.connState === "error" && errorMessage && (
            <div className="mx-4 my-2 px-3.5 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/25 text-rose-300 text-[12.5px] flex items-center justify-between gap-2 animate-fade-in">
              <span className="leading-tight">{errorMessage}</span>
              <button
                type="button"
                onClick={() => wsClient.connect()}
                className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[11.5px] font-semibold shrink-0"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      <main className="flex-1 overflow-hidden relative flex min-h-0">
        {isDesktop ? (
          <DesktopWorkspaceShell
            topHeader={topBrandHeader}
            mainTab={nav.mainTab}
            onSelectMainTab={nav.setMainTab}
            sidebarCollapsed={nav.sidebarCollapsed}
            onToggleSidebar={() => nav.setSidebarCollapsed((v) => !v)}
            workspaces={workspaces}
            loading={loading}
            syncing={syncing}
            totalUnread={totalUnread}
            selectedWorkspace={nav.selectedWorkspace}
            selectedSurface={nav.selectedSurface}
            hosts={hostSession.hosts}
            activeHostId={hostSession.activeHostId}
            activeHost={hostSession.activeHost}
            connState={hostSession.connState}
            hasNoHosts={hasNoHosts}
            errorMessage={errorMessage}
            usage={usageState}
            onRefreshWorkspaces={() => void fetchWorkspaces(true)}
            onSelectWorkspace={nav.selectWorkspace}
            onSelectSurface={nav.selectSurface}
            onBackToSurfaces={nav.backToSurfaces}
            onOpenPairModal={() => hostSession.setShowPairModal(true)}
            onOpenNewSurface={setSidebarNewWs}
            onRequestCloseSurface={(ws, surface) => setSidebarCloseTarget({ ws, surface })}
            onOpenChanges={setChangesWs}
            onSwitchHost={hostSession.handleSwitchHost}
            onRemoveHost={hostSession.handleRemoveHost}
            onRenameHost={hostSession.renameHost}
            onCreateSurface={createSurface}
            onRenameSurface={renameSurface}
            onCloseSurface={(id, wsId) => closeSurface(id, wsId ?? nav.selectedWorkspace?.id)}
          />
        ) : (
          <MobileWorkspaceShell
            mainTab={nav.mainTab}
            onSelectMainTab={nav.setMainTab}
            activeView={nav.activeView}
            workspaces={workspaces}
            loading={loading}
            syncing={syncing}
            totalUnread={totalUnread}
            selectedWorkspace={nav.selectedWorkspace}
            selectedSurface={nav.selectedSurface}
            hosts={hostSession.hosts}
            activeHostId={hostSession.activeHostId}
            activeHost={hostSession.activeHost}
            connState={hostSession.connState}
            usage={usageState}
            onRefreshWorkspaces={() => void fetchWorkspaces(true)}
            onSelectWorkspace={nav.selectWorkspace}
            onSelectSurface={nav.selectSurface}
            onBackToWorkspaces={nav.backToWorkspaces}
            onBackToSurfaces={nav.backToSurfaces}
            onOpenPairModal={() => hostSession.setShowPairModal(true)}
            onSwitchHost={hostSession.handleSwitchHost}
            onRemoveHost={hostSession.handleRemoveHost}
            onRenameHost={hostSession.renameHost}
            onCreateSurface={createSurface}
            onRenameSurface={renameSurface}
            onCloseSurface={(id, wsId) => closeSurface(id, wsId ?? nav.selectedWorkspace?.id)}
          />
        )}
      </main>

      <AppModals
        hosts={hostSession.hosts}
        activeHostId={hostSession.activeHostId}
        connState={hostSession.connState}
        showHostSheet={hostSession.showHostSheet}
        showPairModal={hostSession.showPairModal}
        pendingPairing={hostSession.pendingPairing}
        showTokenModal={hostSession.showTokenModal}
        tokenInput={hostSession.tokenInput}
        activeToasts={notifs.activeToasts}
        sidebarNewWs={sidebarNewWs}
        sidebarCloseTarget={sidebarCloseTarget}
        changesWs={changesWs}
        onSwitchHost={hostSession.handleSwitchHost}
        onOpenPairModal={() => hostSession.setShowPairModal(true)}
        onClosePairModal={() => hostSession.setShowPairModal(false)}
        onPaired={() => void fetchWorkspaces()}
        onManageDevices={nav.setMainTab}
        onCloseHostSheet={() => hostSession.setShowHostSheet(false)}
        onAcceptPairing={hostSession.handleAcceptPairing}
        onRejectPairing={hostSession.handleRejectPairing}
        onSelectToast={(toast) => {
          notifs.dismissToast(toast.notification_id);
          handleJumpToSurface(toast.surface_id);
        }}
        onDismissToast={notifs.dismissToast}
        onCloseNewSurface={() => setSidebarNewWs(null)}
        onCreateSurface={createSurface}
        onCloseSurfaceDialog={() => setSidebarCloseTarget(null)}
        onConfirmCloseSurface={closeSurface}
        onCloseChanges={() => setChangesWs(null)}
        onChangeToken={hostSession.setTokenInput}
        onSaveToken={hostSession.handleSaveToken}
        onCloseTokenModal={() => hostSession.setShowTokenModal(false)}
      />
    </div>
  );
}

export default App;
