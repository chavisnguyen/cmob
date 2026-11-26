import { useCallback, useEffect, useRef, useState } from "react";
import { matchesSurfaceId } from "../domain/workspaceTree";
import { haptic } from "../native/haptics";
import type { LocalNotificationPrefs } from "../notifications/localPrefs";
import { pushManager } from "../notifications/pushManager";
import { RPC_METHODS, type WorkspaceNode } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";
import { stripResolvedQueryParams } from "./useWorkspaceStore";

export function useNotificationBridge({
  connState,
  workspaces,
  workspacesRef,
  localPrefs,
  isViewingSurface,
  viewingSurfaceId,
  onJumpToSurface,
}: {
  connState: ConnectionState;
  workspaces: WorkspaceNode[];
  workspacesRef: React.RefObject<WorkspaceNode[]>;
  localPrefs: LocalNotificationPrefs;
  isViewingSurface: boolean;
  viewingSurfaceId: string | null;
  onJumpToSurface: (surfaceId: string) => void;
}) {
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(() =>
    pushManager.getPermission(),
  );
  const [showIosPwaBanner, setShowIosPwaBanner] = useState(false);
  const pendingColdApproveRef = useRef<{ surfaceId: string; agent?: string } | null>(null);

  const approveSurfaceFromNotification = useCallback(
    async (surfaceId: string, agentHint?: string): Promise<boolean> => {
      if (wsClient.getState() !== "connected") return false;
      let agentKind = agentHint?.trim() || undefined;
      if (!agentKind) {
        for (const ws of workspacesRef.current) {
          const found = ws.surfaces.find((s) => matchesSurfaceId(s, surfaceId));
          if (found?.agent?.agent_kind) {
            agentKind = found.agent.agent_kind;
            break;
          }
        }
      }
      if (!agentKind) return false;
      try {
        await wsClient.call(RPC_METHODS.CHAT_APPROVE, {
          surface_id: surfaceId,
          agent_kind: agentKind,
        });
        return true;
      } catch (err) {
        console.warn("Notification approve action failed:", err);
        return false;
      }
    },
    [workspacesRef],
  );

  // Initialize Service Worker, cold-start approve action, and SW click messages.
  useEffect(() => {
    void pushManager.registerServiceWorker();
    if (pushManager.needsIosPwaInstall()) {
      setShowIosPwaBanner(true);
    }

    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      const urlSurfaceId = sp.get("surface");
      if (urlSurfaceId && sp.get("approve") === "1") {
        pendingColdApproveRef.current = {
          surfaceId: urlSurfaceId,
          agent: sp.get("agent") ?? undefined,
        };
      }
    }

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "cmux.notification.clicked") {
        const targetSurfaceId = event.data.data?.surfaceId;
        if (typeof targetSurfaceId === "string" && targetSurfaceId) {
          onJumpToSurface(targetSurfaceId);
          if (event.data.action === "approve") {
            const agentHint =
              typeof event.data.data?.agent === "string" ? event.data.data.agent : undefined;
            void approveSurfaceFromNotification(targetSurfaceId, agentHint);
          }
        }
      }
    };

    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", handleSwMessage);
    }

    return () => {
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", handleSwMessage);
      }
    };
  }, [onJumpToSurface, approveSurfaceFromNotification]);

  // Execute cold-start `?surface=<id>&approve=1` once connected and workspaces resolve agent_kind.
  useEffect(() => {
    const pending = pendingColdApproveRef.current;
    if (!pending || connState !== "connected") return;
    const hasAgentInfo =
      Boolean(pending.agent) ||
      workspaces.some((ws) =>
        ws.surfaces.some((s) => matchesSurfaceId(s, pending.surfaceId) && Boolean(s.agent)),
      );
    if (!hasAgentInfo) return;
    pendingColdApproveRef.current = null;
    stripResolvedQueryParams(["approve", "agent"]);
    void approveSurfaceFromNotification(pending.surfaceId, pending.agent);
  }, [connState, workspaces, approveSurfaceFromNotification]);

  // Report CLIENT_VIEWING to gateway.
  useEffect(() => {
    if (connState !== "connected") return;
    const sendViewing = () => {
      const visible =
        localPrefs.suppressWhileViewing &&
        (typeof document === "undefined" || document.visibilityState === "visible");
      const surfaceId =
        localPrefs.suppressWhileViewing && isViewingSurface ? viewingSurfaceId : null;
      void wsClient
        .call(RPC_METHODS.CLIENT_VIEWING, { surface_id: surfaceId, visible })
        .catch(() => {});
    };
    sendViewing();
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", sendViewing);
    return () => document.removeEventListener("visibilitychange", sendViewing);
  }, [connState, isViewingSurface, viewingSurfaceId, localPrefs.suppressWhileViewing]);

  const subscribeToPush = useCallback(async () => {
    const { public_key } = await wsClient.call<{ public_key: string }>(RPC_METHODS.PUSH_VAPID_KEY);
    const sub = await pushManager.subscribe(public_key);
    if (sub) await wsClient.call(RPC_METHODS.PUSH_REGISTER, { ...sub });
  }, []);

  const handleToggleNotifications = useCallback(async () => {
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
  }, [subscribeToPush]);

  useEffect(() => {
    if (connState === "connected" && notifPermission === "granted") {
      void subscribeToPush().catch((err) => console.warn("Push re-registration failed:", err));
    }
  }, [connState, notifPermission, subscribeToPush]);

  return {
    notifPermission,
    showIosPwaBanner,
    setShowIosPwaBanner,
    handleToggleNotifications,
  };
}
