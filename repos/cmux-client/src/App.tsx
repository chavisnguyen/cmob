/**
 * cmux-mobile Main PWA Application
 * Implements cmux-Native 3-Level Navigation Hierarchy:
 * - Level 1: WorkspaceListView
 * - Level 2: SurfaceListView
 * - Level 3: SurfaceDetailView (Adaptive Orca Chat vs Raw Terminal)
 * Push & PWA Features:
 * - Service Worker & Web Push Registration (RFC 8292 / VAPID)
 * - iOS Safari PWA Onboarding Banner
 * - Deep-link surface navigation on push click
 * Sources:
 * - architecture.md: Section 5
 * - notification_system.md: Section 3
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Bell,
  BellRing,
  KeyRound,
  MoreHorizontal,
  RefreshCw,
  Server,
  Share2,
  X,
} from "lucide-react";
import type { SurfaceNode, WorkspaceNode } from "./protocol/rpc";
import { RPC_METHODS } from "./protocol/rpc";
import { wsClient, type ConnectionState } from "./transport/wsClient";
import { pushManager } from "./notifications/pushManager";
import { haptic, installGlobalButtonHaptics } from "./native/haptics";
import {
  goBack,
  pushView,
  showDetailEntry,
  useHistoryNavigation,
  type AppView,
} from "./native/navigation";
import { WorkspaceListView } from "./views/WorkspaceListView";
import { SurfaceListView } from "./views/SurfaceListView";
import { SurfaceDetailView } from "./views/SurfaceDetailView";
import { HostsModal } from "./components/hosts/HostsModal";
import type { CreateSurfaceParams } from "./components/surface/NewSurfaceModal";
import { PairingConfirmModal } from "./components/hosts/PairingConfirmModal";

export function App() {
  const [connState, setConnState] = useState<ConnectionState>(wsClient.getState());
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState<"workspaces" | "surfaces" | "detail">("workspaces");
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceNode | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<SurfaceNode | null>(null);
  const [tokenInput, setTokenInput] = useState(wsClient.getToken());
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [showHostsModal, setShowHostsModal] = useState(false);
  const [pendingPairing, setPendingPairing] = useState(wsClient.getPendingPairing());

  // Push notification & iOS PWA Onboarding state
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    pushManager.getPermission(),
  );
  const [showIosPwaBanner, setShowIosPwaBanner] = useState<boolean>(false);

  const selectedWorkspaceRef = useRef(selectedWorkspace);
  const selectedSurfaceRef = useRef(selectedSurface);
  const workspacesRef = useRef(workspaces);

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    selectedSurfaceRef.current = selectedSurface;
  }, [selectedSurface]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  // History API sync: system back / browser back / edge swipe pop one screen at a time.
  const handlePop = useCallback((view: AppView) => {
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

  useEffect(() => installGlobalButtonHaptics(), []);

  // Subscribe to connection state
  useEffect(() => {
    return wsClient.onStateChange((state) => {
      setConnState(state);
      if (state === "error" && !wsClient.getToken()) {
        setShowTokenModal(true);
      }
    });
  }, []);

  useEffect(
    () => wsClient.onPairingChange(() => setPendingPairing(wsClient.getPendingPairing())),
    [],
  );

  // Fetch workspaces tree from Gateway
  const fetchWorkspaces = useCallback(async () => {
    if (wsClient.getState() !== "connected") return;
    setLoading(true);
    try {
      const resp = await wsClient.call<{ workspaces: WorkspaceNode[] }>(RPC_METHODS.WORKSPACE_TREE);
      if (resp?.workspaces) {
        setWorkspaces(resp.workspaces);

        // Keep active workspace/surface updated if already selected
        const curWs = selectedWorkspaceRef.current;
        const curSurf = selectedSurfaceRef.current;
        if (curWs) {
          const updatedWs = resp.workspaces.find((w) => w.id === curWs.id);
          if (updatedWs) {
            setSelectedWorkspace(updatedWs);
            if (curSurf) {
              const updatedSurf = updatedWs.surfaces.find(
                (item) => item.id === curSurf.id || item.ref === curSurf.ref,
              );
              if (updatedSurf) {
                setSelectedSurface(updatedSurf);
              } else if (updatedWs.surfaces.length > 0) {
                setSelectedSurface(updatedWs.surfaces[0]);
              } else {
                setSelectedSurface(null);
                setActiveView("surfaces");
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn("Failed to fetch workspaces:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Connect on mount & initialize Service Worker
  useEffect(() => {
    wsClient.connect();
    void pushManager.registerServiceWorker();

    // Check iOS PWA status
    if (pushManager.needsIosPwaInstall()) {
      setShowIosPwaBanner(true);
    }

    // Listen for notification click message from Service Worker
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "cmux.notification.clicked") {
        const targetSurfaceId = event.data.data?.surfaceId;
        const currentWorkspaces = workspacesRef.current;
        if (targetSurfaceId && currentWorkspaces.length > 0) {
          for (const ws of currentWorkspaces) {
            const match = ws.surfaces.find(
              (s) => s.id === targetSurfaceId || s.ref === targetSurfaceId,
            );
            if (match) {
              setSelectedWorkspace(ws);
              setSelectedSurface(match);
              setActiveView("detail");
              showDetailEntry();
              break;
            }
          }
        }
      }
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", handleSwMessage);
    }

    return () => {
      wsClient.disconnect();
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", handleSwMessage);
      }
    };
  }, []);

  useEffect(() => {
    if (connState === "connected") {
      void fetchWorkspaces();
      const interval = setInterval(() => {
        void fetchWorkspaces();
      }, 2500);
      return () => clearInterval(interval);
    }
  }, [connState, fetchWorkspaces]);

  // Dynamic Visual Viewport tracking for iOS Virtual Keyboard & Standalone PWA
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;

    const preventWindowScroll = () => {
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const updateViewportHeight = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
      // iOS scrolls the visual viewport to reveal a focused input; keep the fixed root glued to it
      // so no gap opens between the composer and the keyboard.
      document.documentElement.style.setProperty("--app-top", `${vv.offsetTop}px`);
      preventWindowScroll();
    };

    window.visualViewport.addEventListener("resize", updateViewportHeight);
    window.visualViewport.addEventListener("scroll", updateViewportHeight);
    window.addEventListener("scroll", preventWindowScroll, { passive: true });
    updateViewportHeight();

    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
      window.visualViewport?.removeEventListener("scroll", updateViewportHeight);
      window.removeEventListener("scroll", preventWindowScroll);
    };
  }, []);

  const handleForceReload = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("reload", Date.now().toString());
      window.location.href = url.toString();
    } catch {
      window.location.reload();
    }
  };

  const handleSelectWorkspace = (ws: WorkspaceNode) => {
    setSelectedWorkspace(ws);
    setActiveView("surfaces");
    pushView("surfaces");
  };

  const handleSelectSurface = (surf: SurfaceNode) => {
    setSelectedSurface(surf);
    showDetailEntry();
    setActiveView("detail");
  };

  const handleBackToWorkspaces = () =>
    goBack(() => {
      setActiveView("workspaces");
      setSelectedWorkspace(null);
      setSelectedSurface(null);
    });

  const handleBackToSurfaces = () =>
    goBack(() => {
      setActiveView("surfaces");
      setSelectedSurface(null);
    });

  const handleSaveToken = () => {
    wsClient.setToken(tokenInput.trim());
    setShowTokenModal(false);
  };

  // Subscribe this browser to Web Push using the gateway's VAPID key and register it.
  const subscribeToPush = useCallback(async () => {
    const { public_key } = await wsClient.call<{ public_key: string }>(RPC_METHODS.PUSH_VAPID_KEY);
    const sub = await pushManager.subscribe(public_key);
    if (sub) await wsClient.call(RPC_METHODS.PUSH_REGISTER, { ...sub });
  }, []);

  const handleToggleNotifications = async () => {
    try {
      const perm = await pushManager.requestPermission();
      setNotifPermission(perm);
      if (perm === "granted") {
        await subscribeToPush();
        haptic("success");
      }
    } catch (err) {
      console.warn("Failed to enable push notifications:", err);
    }
  };

  // Keep the gateway's subscription list fresh (gateway restarts, browser rotated the endpoint).
  useEffect(() => {
    if (connState === "connected" && notifPermission === "granted") {
      void subscribeToPush().catch((err) => console.warn("Push re-registration failed:", err));
    }
  }, [connState, notifPermission, subscribeToPush]);

  const handleCreateSurface = useCallback(
    async (params: CreateSurfaceParams) => {
      await wsClient.call(RPC_METHODS.SURFACE_NEW, {
        workspace_id: params.workspaceId,
        command: params.command,
        ...(params.launch ? { launch: params.launch } : {}),
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  const handleRenameSurface = useCallback(
    async (surfaceId: string, title: string) => {
      await wsClient.call(RPC_METHODS.SURFACE_RENAME, {
        surface_id: surfaceId,
        title,
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  const handleCloseSurface = useCallback(
    async (surfaceId: string) => {
      await wsClient.call(RPC_METHODS.SURFACE_CLOSE, {
        surface_id: surfaceId,
        force: true,
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  return (
    <div className="flex flex-col h-full w-full max-w-full overflow-hidden bg-[#0a0a0a] font-sans antialiased select-none">
      {showIosPwaBanner && (
        <div className="flex items-center justify-between gap-2 px-4 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-2 bg-[#171717] border-b border-white/[0.08] text-[13px] text-[#e5e5e5] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-[#8ab4f8] shrink-0" />
            <span className="leading-snug">
              Tap Share then &apos;Add to Home Screen&apos; to enable PWA lock-screen push.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowIosPwaBanner(false)}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-[#a3a3a3] hover:text-white flex items-center justify-center shrink-0"
            aria-label="Dismiss banner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {activeView !== "detail" && (
        <div
          className={`flex items-center justify-between px-4 ${
            showIosPwaBanner
              ? "min-h-[52px]"
              : "pt-[env(safe-area-inset-top,0px)] min-h-[calc(3.25rem+env(safe-area-inset-top,0px))]"
          } relative bg-[#141416] border-b border-white/[0.08] shrink-0 z-30`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-[17px] font-bold tracking-tight text-[#fafafa]">cmux</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[12px] font-medium ${
                connState === "connected"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : connState === "connecting" || connState === "authenticating"
                    ? "bg-amber-500/15 text-amber-300"
                    : "bg-rose-500/15 text-rose-400"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  connState === "connected"
                    ? "bg-emerald-400"
                    : connState === "connecting" || connState === "authenticating"
                      ? "bg-amber-400"
                      : "bg-rose-400"
                }`}
              />
              <span className="capitalize">{connState}</span>
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleToggleNotifications}
              className={`w-9 h-9 rounded-xl bg-[#242428] hover:bg-[#2e2e34] flex items-center justify-center transition-colors ${
                notifPermission === "granted"
                  ? "text-emerald-400"
                  : notifPermission === "denied"
                    ? "text-[#525252] cursor-not-allowed"
                    : "text-amber-300"
              }`}
              title={`Notifications: ${notifPermission}`}
              aria-label="Notifications"
            >
              {notifPermission === "granted" ? (
                <BellRing className="w-[18px] h-[18px]" />
              ) : (
                <Bell className="w-[18px] h-[18px]" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowAppMenu((v) => !v)}
              className="w-9 h-9 rounded-xl bg-[#242428] hover:bg-[#2e2e34] text-[#e5e5e5] flex items-center justify-center transition-colors"
              title="Menu"
              aria-label="Menu"
              aria-expanded={showAppMenu}
            >
              <MoreHorizontal className="w-[18px] h-[18px]" />
            </button>

            {showAppMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowAppMenu(false)} />
                <div className="absolute right-3 top-[calc(100%-4px)] z-50 w-56 rounded-2xl bg-[#1c1c20] border border-white/[0.12] shadow-2xl py-1.5 overflow-hidden">
                  {[
                    { label: "Hosts & devices", icon: Server, run: () => setShowHostsModal(true) },
                    { label: "Auth token", icon: KeyRound, run: () => setShowTokenModal(true) },
                    { label: "Reload app", icon: RefreshCw, run: handleForceReload },
                  ].map(({ label, icon: Icon, run }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setShowAppMenu(false);
                        run();
                      }}
                      className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-[#fafafa] hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                    >
                      <Icon className="w-4 h-4 text-[#a3a3a3]" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Main 3-Level Content Area */}
      <main className="flex-1 overflow-hidden">
        {activeView === "workspaces" && (
          <WorkspaceListView
            workspaces={workspaces}
            loading={loading}
            onRefresh={fetchWorkspaces}
            onSelectWorkspace={handleSelectWorkspace}
          />
        )}

        {activeView === "surfaces" && selectedWorkspace && (
          <SurfaceListView
            workspace={selectedWorkspace}
            onBack={handleBackToWorkspaces}
            onSelectSurface={handleSelectSurface}
            onCreateSurface={handleCreateSurface}
            onRenameSurface={handleRenameSurface}
            onCloseSurface={handleCloseSurface}
            onRefresh={fetchWorkspaces}
          />
        )}

        {activeView === "detail" && selectedWorkspace && selectedSurface && (
          <SurfaceDetailView
            // Per-surface state (pending sends, working flag, history paging) must not leak between tabs.
            key={selectedSurface.id || selectedSurface.ref}
            surface={selectedSurface}
            workspace={selectedWorkspace}
            onBack={handleBackToSurfaces}
            allSurfaces={selectedWorkspace.surfaces}
            onSelectSurface={handleSelectSurface}
            onCreateSurface={handleCreateSurface}
            onRenameSurface={handleRenameSurface}
            onCloseSurface={handleCloseSurface}
            onRefresh={fetchWorkspaces}
          />
        )}
      </main>

      {pendingPairing && (
        <PairingConfirmModal
          offer={pendingPairing}
          onAccept={() => wsClient.acceptPendingPairing()}
          onReject={() => wsClient.rejectPendingPairing()}
        />
      )}
      {showHostsModal && <HostsModal onClose={() => setShowHostsModal(false)} />}

      {showTokenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm p-5 rounded-2xl bg-[#171717] border border-white/[0.1] text-[#fafafa] shadow-2xl space-y-4">
            <h2 className="text-[16px] font-semibold flex items-center gap-2.5">
              <KeyRound className="w-5 h-5 text-[#8ab4f8]" />
              <span>Gateway Auth Token</span>
            </h2>
            <p className="text-[13px] text-[#a3a3a3] leading-relaxed">
              Enter the bearer token printed in your cmux-gateway terminal or scanned from the QR
              code.
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="cmux_sec_..."
              className="w-full h-11 bg-[#0a0a0a] border border-white/[0.14] focus:border-[#3276f2] rounded-xl px-3.5 text-[15px] font-mono text-[#fafafa] placeholder-[#737373] outline-none"
            />
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setShowTokenModal(false)}
                className="flex-1 h-11 rounded-xl bg-[#262626] hover:bg-[#303036] text-[14px] font-semibold text-[#e5e5e5] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveToken}
                className="flex-1 h-11 rounded-xl bg-[#3276f2] hover:bg-[#2563eb] text-[14px] font-semibold text-white transition-colors"
              >
                Save & Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
