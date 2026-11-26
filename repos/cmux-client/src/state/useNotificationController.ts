import { useCallback, useEffect, useRef, useState } from "react";
import {
  TOAST_DURATION_MS,
  isSurfaceAlertSuppressed,
  plainNotificationBody,
  reduceNotificationToasts,
  shouldTriggerBrowserNotification,
  type NotificationToastAction,
} from "../domain/notificationCenter";
import { haptic } from "../native/haptics";
import {
  loadLocalNotificationPrefs,
  parseNotificationAlert,
  subscribeLocalNotificationPrefs,
  type LocalNotificationPrefs,
} from "../notifications/localPrefs";
import { pushManager } from "../notifications/pushManager";
import {
  RPC_EVENTS,
  type NotificationAlertPayload,
  type NotificationDismissPayload,
  type SurfaceNode,
  type WorkspaceNode,
} from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";
import { useNotificationBridge } from "./useNotificationBridge";

export interface UseNotificationControllerOptions {
  connState: ConnectionState;
  workspaces: WorkspaceNode[];
  workspacesRef: React.RefObject<WorkspaceNode[]>;
  selectedSurface: SurfaceNode | null;
  isViewingSurface: boolean;
  viewingSurfaceId: string | null;
  onJumpToSurface: (surfaceId: string) => void;
  onNotificationStateChange?: () => void;
}

export function useNotificationController({
  connState,
  workspaces,
  workspacesRef,
  selectedSurface,
  isViewingSurface,
  viewingSurfaceId,
  onJumpToSurface,
  onNotificationStateChange,
}: UseNotificationControllerOptions) {
  const [localPrefs, setLocalPrefs] = useState<LocalNotificationPrefs>(() =>
    loadLocalNotificationPrefs(),
  );
  const [activeToasts, setActiveToasts] = useState<NotificationAlertPayload[]>([]);

  const toastsRef = useRef<NotificationAlertPayload[]>([]);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const browserNotifsRef = useRef<Map<string, Notification>>(new Map());
  const seenNotifIdsRef = useRef<string[]>([]);
  const localPrefsRef = useRef(localPrefs);
  const selectedSurfaceRef = useRef(selectedSurface);
  const isViewingSurfaceRef = useRef(isViewingSurface);
  const onNotificationStateChangeRef = useRef(onNotificationStateChange);

  useEffect(() => {
    localPrefsRef.current = localPrefs;
  }, [localPrefs]);

  useEffect(() => {
    selectedSurfaceRef.current = selectedSurface;
  }, [selectedSurface]);

  useEffect(() => {
    isViewingSurfaceRef.current = isViewingSurface;
  }, [isViewingSurface]);

  useEffect(() => {
    onNotificationStateChangeRef.current = onNotificationStateChange;
  }, [onNotificationStateChange]);

  useEffect(() => subscribeLocalNotificationPrefs(setLocalPrefs), []);

  const { notifPermission, showIosPwaBanner, setShowIosPwaBanner, handleToggleNotifications } =
    useNotificationBridge({
      connState,
      workspaces,
      workspacesRef,
      localPrefs,
      isViewingSurface,
      viewingSurfaceId,
      onJumpToSurface,
    });

  useEffect(() => {
    const timers = toastTimersRef.current;
    const browserNotifs = browserNotifsRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const n of browserNotifs.values()) n.close();
      browserNotifs.clear();
    };
  }, []);

  const clearTimersForIds = useCallback((ids: readonly string[]) => {
    for (const id of ids) {
      const timer = toastTimersRef.current.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        toastTimersRef.current.delete(id);
      }
    }
  }, []);

  const dispatchToast = useCallback(
    (action: NotificationToastAction) => {
      const { toasts, evictedIds } = reduceNotificationToasts(toastsRef.current, action);
      clearTimersForIds(evictedIds);
      toastsRef.current = toasts;
      setActiveToasts(toasts);
    },
    [clearTimersForIds],
  );

  const clearAllToasts = useCallback(() => dispatchToast({ type: "clear" }), [dispatchToast]);

  const dismissToast = useCallback(
    (notificationId: string) => dispatchToast({ type: "dismiss_by_id", notificationId }),
    [dispatchToast],
  );

  const dismissToastsForSurface = useCallback(
    (surface: Pick<SurfaceNode, "id" | "ref"> | string) =>
      dispatchToast({ type: "dismiss_for_surface", surface }),
    [dispatchToast],
  );

  // Clear toasts matching either `surface.id` or `surface.ref` when the user opens that surface.
  useEffect(() => {
    if (isViewingSurface && selectedSurface) {
      dismissToastsForSurface(selectedSurface);
    }
  }, [isViewingSurface, selectedSurface, dismissToastsForSurface]);

  // Subscribe to gateway notification alerts and dismissals.
  useEffect(() => {
    return wsClient.onEvent((event, data) => {
      if (event === RPC_EVENTS.NOTIFICATION_ALERT) {
        const alert = parseNotificationAlert(data);
        if (!alert) return;

        if (seenNotifIdsRef.current.includes(alert.notification_id)) return;
        seenNotifIdsRef.current.push(alert.notification_id);
        if (seenNotifIdsRef.current.length > 100) seenNotifIdsRef.current.shift();

        const prefs = localPrefsRef.current;
        const tabVisible =
          typeof document === "undefined" || document.visibilityState === "visible";

        if (
          isSurfaceAlertSuppressed({
            prefs,
            alertSurfaceId: alert.surface_id,
            viewingSurface: selectedSurfaceRef.current,
            isViewingSurface: isViewingSurfaceRef.current,
            tabVisible,
          })
        ) {
          return;
        }

        if (prefs.inAppToast) {
          dispatchToast({ type: "add", alert });
          const timer = setTimeout(() => {
            dispatchToast({ type: "dismiss_by_id", notificationId: alert.notification_id });
          }, TOAST_DURATION_MS);
          toastTimersRef.current.set(alert.notification_id, timer);
        }

        if (
          shouldTriggerBrowserNotification({
            prefs,
            tabVisible,
            permission: pushManager.getPermission(),
          }) &&
          typeof Notification === "function"
        ) {
          try {
            browserNotifsRef.current.get(alert.tag)?.close();
            const notif = new Notification(alert.title, {
              body: plainNotificationBody(alert.body),
              tag: alert.tag,
            });
            notif.onclick = () => {
              window.focus?.();
              onJumpToSurface(alert.surface_id);
              notif.close();
            };
            browserNotifsRef.current.set(alert.tag, notif);
          } catch {
            // Some mobile browsers disallow `new Notification` outside ServiceWorkerRegistration.
          }
        }

        haptic(alert.urgent ? "medium" : "light");
        onNotificationStateChangeRef.current?.();
      } else if (event === RPC_EVENTS.NOTIFICATION_DISMISS) {
        const payload = data as NotificationDismissPayload;
        if (payload?.tags) {
          dispatchToast({
            type: "dismiss_by_tags",
            surfaceId: payload.surface_id,
            tags: payload.tags,
          });
          for (const tag of payload.tags) {
            const openNotif = browserNotifsRef.current.get(tag);
            if (openNotif) {
              openNotif.close();
              browserNotifsRef.current.delete(tag);
            }
          }
        }
        onNotificationStateChangeRef.current?.();
      }
    });
  }, [dispatchToast, onJumpToSurface]);

  return {
    notifPermission,
    showIosPwaBanner,
    setShowIosPwaBanner,
    activeToasts,
    dismissToast,
    dismissToastsForSurface,
    clearAllToasts,
    handleToggleNotifications,
  };
}
