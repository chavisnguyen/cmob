/**
 * cmux-mobile Main PWA Application
 * Implements cmux-Native 3-Level Navigation Hierarchy:
 * - Level 1: WorkspaceListView
 * - Level 2: SurfaceListView
 * - Level 3: SurfaceDetailView (Adaptive Orca Chat vs Raw Terminal)
 * Multi-Device & Companion Features:
 * - HostSwitchSheet: switch between paired computers from the connection pill
 * - DeviceListView: Comprehensive device and client token manager
 * Push & PWA Features:
 * - Service Worker & Web Push Registration (RFC 8292 / VAPID)
 * - iOS Safari PWA Onboarding Banner
 * - Deep-link surface navigation on push click
 * Sources:
 * - architecture.md: Section 5
 * - notification_system.md: Section 3
 * - ref/orca/mobile/src/home/tabs/MobileHomeTabBar.tsx
 * - ref/orca/mobile/src/session/tabs/MobileSessionTabStrip.tsx
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Bell,
  ChevronDown,
  BellRing,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Server,
  Share2,
  X,
} from "lucide-react";
import type {
  NotificationAlertPayload,
  NotificationDismissPayload,
  SurfaceNode,
  WorkspaceNode,
} from "./protocol/rpc";
import { RPC_EVENTS, RPC_METHODS } from "./protocol/rpc";
import { wsClient, type ConnectionState } from "./transport/wsClient";
import { pushManager } from "./notifications/pushManager";
import {
  isAlertSuppressedForView,
  loadLocalNotificationPrefs,
  parseNotificationAlert,
  subscribeLocalNotificationPrefs,
  type LocalNotificationPrefs,
} from "./notifications/localPrefs";
import { haptic, installGlobalButtonHaptics } from "./native/haptics";
import {
  goBack,
  pushView,
  replaceView,
  showDetailEntry,
  useHistoryNavigation,
  type AppView,
} from "./native/navigation";
import { WorkspaceListView } from "./views/WorkspaceListView";
import { SurfaceListView } from "./views/SurfaceListView";
import { SurfaceDetailView } from "./views/SurfaceDetailView";
import { DeviceListView } from "./views/DeviceListView";
import { PairHostModal } from "./components/hosts/PairHostModal";
import { HostSwitchSheet } from "./components/hosts/HostSwitchSheet";
import type { CreateSurfaceParams } from "./components/surface/NewSurfaceModal";
import { PairingConfirmModal } from "./components/hosts/PairingConfirmModal";
import { useHosts } from "./hosts/useHosts";
import type { SavedHost } from "./hosts/hostStore";
import { isDemoMode } from "./demo/demoData";

/** Notification bodies carry raw agent markdown; show them as plain text. */
const plainText = (md: string) =>
  md
    .replace(/^\s*-\s+/gm, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function App() {
  const [connState, setConnState] = useState<ConnectionState>(wsClient.getState());
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [mainTab, setMainTab] = useState<"workspaces" | "devices">("workspaces");
  const [showHostSheet, setShowHostSheet] = useState(false);
  const [activeView, setActiveView] = useState<"workspaces" | "surfaces" | "detail">("workspaces");
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceNode | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<SurfaceNode | null>(null);
  const [tokenInput, setTokenInput] = useState(wsClient.getToken());
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [showPairModal, setShowPairModal] = useState(false);
  const [pendingPairing, setPendingPairing] = useState(wsClient.getPendingPairing());

  const { hosts, activeHostId, activeHost, switchHost, removeHost, renameHost } = useHosts();

  // Push notification & iOS PWA Onboarding state
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    pushManager.getPermission(),
  );
  const [showIosPwaBanner, setShowIosPwaBanner] = useState<boolean>(false);
  const [localPrefs, setLocalPrefs] = useState<LocalNotificationPrefs>(() =>
    loadLocalNotificationPrefs(),
  );
  const [activeToasts, setActiveToasts] = useState<NotificationAlertPayload[]>([]);

  const selectedWorkspaceRef = useRef(selectedWorkspace);
  const selectedSurfaceRef = useRef(selectedSurface);
  const workspacesRef = useRef(workspaces);
  const activeViewRef = useRef(activeView);
  const localPrefsRef = useRef(localPrefs);
  const seenNotifIdsRef = useRef<string[]>([]);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const isFetchingRef = useRef<boolean>(false);
  const pendingSurfaceJumpRef = useRef<string | null>(null);

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    selectedSurfaceRef.current = selectedSurface;
  }, [selectedSurface]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    localPrefsRef.current = localPrefs;
  }, [localPrefs]);

  useEffect(() => subscribeLocalNotificationPrefs(setLocalPrefs), []);

  const jumpToSurface = useCallback((targetSurfaceId: string) => {
    const currentWorkspaces = workspacesRef.current;
    for (const ws of currentWorkspaces) {
      const match = ws.surfaces.find((s) => s.id === targetSurfaceId || s.ref === targetSurfaceId);
      if (match) {
        setMainTab("workspaces");
        setSelectedWorkspace(ws);
        setSelectedSurface(match);
        setActiveView("detail");
        showDetailEntry();
        setActiveToasts((prev) => prev.filter((t) => t.surface_id !== match.id));
        return;
      }
    }
  }, []);

  // History API sync: system back / browser back / edge swipe pop one screen at a time.
  const handlePop = useCallback(
    (view: AppView) => {
      if (mainTab !== "workspaces") {
        setMainTab("workspaces");
        return;
      }
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
    },
    [mainTab],
  );
  useHistoryNavigation(handlePop);

  useEffect(() => installGlobalButtonHaptics(), []);

  // Subscribe to connection state
  useEffect(() => {
    return wsClient.onStateChange((state) => {
      setConnState(state);
    });
  }, []);

  useEffect(
    () => wsClient.onPairingChange(() => setPendingPairing(wsClient.getPendingPairing())),
    [],
  );

  // Fetch workspaces tree from Gateway
  const fetchWorkspaces = useCallback(async () => {
    if (wsClient.getState() !== "connected") return;
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
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
      isFetchingRef.current = false;
      setLoading(false);
    }
  }, []);

  const handleSwitchHost = useCallback(
    (host: SavedHost) => {
      setSelectedWorkspace(null);
      setSelectedSurface(null);
      setActiveView("workspaces");
      replaceView("workspaces");
      setWorkspaces([]);
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
      setActiveToasts([]);
      switchHost(host);
    },
    [switchHost],
  );

  const handleRemoveHost = useCallback(
    (id: string) => {
      if (activeHostId === id) {
        setSelectedWorkspace(null);
        setSelectedSurface(null);
        setActiveView("workspaces");
        replaceView("workspaces");
        setWorkspaces([]);
        for (const timer of toastTimersRef.current.values()) {
          clearTimeout(timer);
        }
        toastTimersRef.current.clear();
        setActiveToasts([]);
      }
      removeHost(id);
    },
    [activeHostId, removeHost],
  );

  useEffect(() => {
    setTokenInput(wsClient.getToken());
  }, [activeHostId]);

  // Connect on mount & initialize Service Worker
  useEffect(() => {
    wsClient.connect();
    void pushManager.registerServiceWorker();

    // Check for cold-start deep link from Web Push notifications: ?surface=<id>
    if (typeof window !== "undefined") {
      const urlSurfaceId = new URLSearchParams(window.location.search).get("surface");
      if (urlSurfaceId) {
        pendingSurfaceJumpRef.current = urlSurfaceId;
        jumpToSurface(urlSurfaceId);
      }
    }

    // Check iOS PWA status
    if (pushManager.needsIosPwaInstall()) {
      setShowIosPwaBanner(true);
    }

    // Listen for notification click message from Service Worker
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "cmux.notification.clicked") {
        const targetSurfaceId = event.data.data?.surfaceId;
        if (typeof targetSurfaceId === "string" && targetSurfaceId) {
          jumpToSurface(targetSurfaceId);
        }
      }
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", handleSwMessage);
    }

    const toastTimers = toastTimersRef.current;
    return () => {
      wsClient.disconnect();
      for (const timer of toastTimers.values()) {
        clearTimeout(timer);
      }
      toastTimers.clear();
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", handleSwMessage);
      }
    };
  }, [jumpToSurface]);

  useEffect(() => {
    if (connState === "connected") {
      void fetchWorkspaces();
      const interval = setInterval(() => {
        void fetchWorkspaces();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [connState, fetchWorkspaces]);

  // Resolve cold-start deep-link to surface once workspaces are loaded
  useEffect(() => {
    if (pendingSurfaceJumpRef.current && workspaces.length > 0) {
      const target = pendingSurfaceJumpRef.current;
      jumpToSurface(target);
      for (const ws of workspaces) {
        if (ws.surfaces.some((s) => s.id === target || s.ref === target)) {
          pendingSurfaceJumpRef.current = null;
          break;
        }
      }
    }
  }, [workspaces, jumpToSurface]);

  const viewingSurfaceId = selectedSurface?.id ?? null;

  // Report active surface & visibility to the gateway so suppressWhileViewing works across WebSocket and Web Push.
  useEffect(() => {
    if (connState !== "connected") return;
    const sendViewing = () => {
      const visible =
        localPrefs.suppressWhileViewing &&
        (typeof document === "undefined" || document.visibilityState === "visible");
      const surfaceId =
        localPrefs.suppressWhileViewing && activeView === "detail" ? viewingSurfaceId : null;
      void wsClient
        .call(RPC_METHODS.CLIENT_VIEWING, {
          surface_id: surfaceId,
          visible,
        })
        .catch(() => {});
    };
    sendViewing();
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", sendViewing);
    return () => document.removeEventListener("visibilitychange", sendViewing);
  }, [connState, activeView, viewingSurfaceId, localPrefs.suppressWhileViewing]);

  // Clear toasts for the surface the user just opened.
  useEffect(() => {
    if (activeView === "detail" && selectedSurface) {
      setActiveToasts((prev) => prev.filter((t) => t.surface_id !== selectedSurface.id));
    }
  }, [activeView, selectedSurface]);

  // Listen to live gateway notification alerts and dismissals.
  useEffect(() => {
    return wsClient.onEvent((event, data) => {
      if (event === RPC_EVENTS.NOTIFICATION_ALERT) {
        const alert = parseNotificationAlert(data);
        if (!alert) return;

        if (seenNotifIdsRef.current.includes(alert.notification_id)) return;
        seenNotifIdsRef.current.push(alert.notification_id);
        if (seenNotifIdsRef.current.length > 100) {
          seenNotifIdsRef.current.shift();
        }

        const prefs = localPrefsRef.current;
        const tabVisible =
          typeof document === "undefined" || document.visibilityState === "visible";
        const viewingSurfaceId =
          activeViewRef.current === "detail" ? (selectedSurfaceRef.current?.id ?? null) : null;
        if (isAlertSuppressedForView(prefs, alert.surface_id, viewingSurfaceId, tabVisible)) {
          return;
        }

        if (prefs.inAppToast) {
          setActiveToasts((prev) => {
            const withoutSameTag = prev.filter((t) => t.tag !== alert.tag);
            return [alert, ...withoutSameTag].slice(0, 3);
          });

          const timer = setTimeout(() => {
            setActiveToasts((prev) =>
              prev.filter((t) => t.notification_id !== alert.notification_id),
            );
            toastTimersRef.current.delete(alert.notification_id);
          }, 8000);
          toastTimersRef.current.set(alert.notification_id, timer);
        }

        haptic(alert.urgent ? "medium" : "light");
      } else if (event === RPC_EVENTS.NOTIFICATION_DISMISS) {
        const payload = data as NotificationDismissPayload;
        if (payload?.tags) {
          const dismissTags = new Set(payload.tags);
          setActiveToasts((prev) =>
            prev.filter((t) => {
              if (t.surface_id === payload.surface_id && dismissTags.has(t.tag)) {
                const timer = toastTimersRef.current.get(t.notification_id);
                if (timer) {
                  clearTimeout(timer);
                  toastTimersRef.current.delete(t.notification_id);
                }
                return false;
              }
              return true;
            }),
          );
        }
      }
    });
  }, []);

  // Dynamic Visual Viewport tracking for iOS Virtual Keyboard & Standalone PWA: index.css sizes the
  // fixed root with --app-height/--app-top, so the composer rides above the keyboard.
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
    haptic("medium");
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
        workspace_id: selectedWorkspaceRef.current?.id,
        force: true,
      });
      await fetchWorkspaces();
    },
    [fetchWorkspaces],
  );

  return (
    <div className="flex flex-col h-full w-full max-w-full overflow-hidden bg-bg font-sans antialiased select-none">
      {showIosPwaBanner && (
        <div className="flex items-center justify-between gap-2 px-4 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] pb-2 bg-bg border-b border-white/[0.08] text-[13px] text-fg-soft shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-accent-soft shrink-0" />
            <span className="leading-snug">
              Tap Share then &apos;Add to Home Screen&apos; to enable PWA lock-screen push.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowIosPwaBanner(false)}
            className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-muted hover:text-white flex items-center justify-center shrink-0"
            aria-label="Dismiss banner"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Top Header & Device Tab Strip */}
      {activeView !== "detail" && (
        <div className="flex flex-col shrink-0 z-30">
          <div
            className={`flex items-center justify-between px-4 ${
              showIosPwaBanner
                ? "min-h-[50px]"
                : "pt-[env(safe-area-inset-top,0px)] min-h-[calc(3.25rem+env(safe-area-inset-top,0px))]"
            } relative bg-bg border-b border-line`}
          >
            <div className="flex items-center gap-2.5">
              <span className="text-[17px] font-bold tracking-tight text-fg">Cmob</span>
              <button
                type="button"
                onClick={() => setShowHostSheet(true)}
                aria-label={`Switch computer (${connState})`}
                className="inline-flex items-center gap-1.5 min-w-0 max-w-[180px] pl-2.5 pr-2 py-1 rounded-full bg-raised hover:bg-line text-[12.5px] font-medium text-fg-soft transition-colors"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    connState === "connected"
                      ? "bg-emerald-400"
                      : connState === "connecting" || connState === "authenticating"
                        ? "bg-amber-400 animate-pulse"
                        : "bg-rose-400"
                  }`}
                />
                <span className="truncate">{activeHost?.name ?? "No computer"}</span>
                <ChevronDown className="w-3 h-3 shrink-0 text-muted" />
              </button>
              {isDemoMode() && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-accent/20 text-accent-soft border border-accent/30">
                  Demo
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleToggleNotifications}
                className={`w-9 h-9 rounded-xl bg-raised hover:bg-line flex items-center justify-center transition-colors ${
                  notifPermission === "granted"
                    ? "text-emerald-400"
                    : notifPermission === "denied"
                      ? "text-dim cursor-not-allowed"
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
                className="w-9 h-9 rounded-xl bg-raised hover:bg-line text-fg-soft flex items-center justify-center transition-colors"
                title="Menu"
                aria-label="Menu"
                aria-expanded={showAppMenu}
              >
                <MoreHorizontal className="w-[18px] h-[18px]" />
              </button>

              {showAppMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAppMenu(false)} />
                  <div className="absolute right-3 top-[calc(100%-4px)] z-50 w-56 rounded-2xl bg-surface border border-white/[0.12] shadow-2xl py-1.5 overflow-hidden">
                    {[
                      { label: "Pair new device", icon: Plus, run: () => setShowPairModal(true) },
                      { label: "Hosts & devices", icon: Server, run: () => setMainTab("devices") },
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
                        className="w-full min-h-[44px] px-4 flex items-center gap-3 text-[14px] font-medium text-fg hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
                      >
                        <Icon className="w-4 h-4 text-muted" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {connState === "error" && wsClient.getLastErrorMessage() && (
            <div className="mx-4 my-2 px-3.5 py-2.5 rounded-xl bg-rose-500/15 border border-rose-500/25 text-rose-300 text-[12.5px] flex items-center justify-between gap-2 animate-fade-in">
              <span className="leading-tight">{wsClient.getLastErrorMessage()}</span>
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

      {/* Main Content Area */}
      <main className="flex-1 overflow-hidden relative">
        {mainTab === "workspaces" && (
          <>
            {activeView === "workspaces" && (
              <WorkspaceListView
                workspaces={workspaces}
                loading={loading}
                onRefresh={fetchWorkspaces}
                onSelectWorkspace={handleSelectWorkspace}
                hostsCount={hosts.length}
                connState={connState}
                onPairHost={() => setShowPairModal(true)}
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
          </>
        )}

        {mainTab === "devices" && (
          <DeviceListView
            hosts={hosts}
            activeHostId={activeHostId}
            connState={connState}
            onSelectHost={(h) => {
              handleSwitchHost(h);
              setMainTab("workspaces");
            }}
            onRemoveHost={handleRemoveHost}
            onRenameHost={renameHost}
            onBack={() => setMainTab("workspaces")}
          />
        )}
      </main>

      {showHostSheet && (
        <HostSwitchSheet
          hosts={hosts}
          activeHostId={activeHostId}
          connState={connState}
          onSelect={handleSwitchHost}
          onAdd={() => setShowPairModal(true)}
          onManage={() => setMainTab("devices")}
          onClose={() => setShowHostSheet(false)}
        />
      )}

      {/* Floating In-App Toast Banners */}
      {activeToasts.length > 0 && (
        <div className="fixed top-[calc(0.75rem+env(safe-area-inset-top,0px))] right-3 left-3 sm:left-auto sm:w-96 z-50 flex flex-col gap-2 pointer-events-none">
          {activeToasts.map((toast) => (
            <div
              key={toast.notification_id}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-2xl bg-raised border border-line border-l-[3px] pl-3 pr-2 py-2.5 shadow-lg ${
                toast.category === "agent-error"
                  ? "border-l-rose-400"
                  : toast.urgent || toast.category === "needs-permission"
                    ? "border-l-amber-400"
                    : "border-l-accent"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  setActiveToasts((prev) =>
                    prev.filter((t) => t.notification_id !== toast.notification_id),
                  );
                  jumpToSurface(toast.surface_id);
                }}
                className="flex-1 min-w-0 text-left"
              >
                <div className="text-[13px] font-semibold leading-snug truncate">{toast.title}</div>
                <div className="text-[12.5px] text-fg-soft leading-snug line-clamp-2 mt-0.5">
                  {plainText(toast.body)}
                </div>
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveToasts((prev) =>
                    prev.filter((t) => t.notification_id !== toast.notification_id),
                  )
                }
                className="w-7 h-7 rounded-lg hover:bg-white/[0.1] text-muted hover:text-white flex items-center justify-center shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {showPairModal && (
        <PairHostModal
          onClose={() => setShowPairModal(false)}
          onPaired={() => {
            void fetchWorkspaces();
          }}
        />
      )}

      {pendingPairing && (
        <PairingConfirmModal
          offer={pendingPairing}
          onAccept={() => wsClient.acceptPendingPairing()}
          onReject={() => wsClient.rejectPendingPairing()}
        />
      )}

      {showTokenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm p-5 rounded-2xl bg-bg border border-white/[0.1] text-fg shadow-2xl space-y-4">
            <h2 className="text-[16px] font-semibold flex items-center gap-2.5">
              <KeyRound className="w-5 h-5 text-accent-soft" />
              <span>Gateway Auth Token</span>
            </h2>
            <p className="text-[13px] text-muted leading-relaxed">
              Enter the bearer token printed in your cmux-gateway terminal or scanned from the QR
              code.
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="cmux_sec_..."
              className="w-full h-11 bg-bg border border-white/[0.14] focus:border-accent rounded-xl px-3.5 text-[15px] font-mono text-fg placeholder-dim outline-none"
            />
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setShowTokenModal(false)}
                className="flex-1 h-11 rounded-xl bg-raised hover:bg-line text-[14px] font-semibold text-fg-soft transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveToken}
                className="flex-1 h-11 rounded-xl bg-accent hover:bg-accent-strong text-[14px] font-semibold text-white transition-colors"
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
