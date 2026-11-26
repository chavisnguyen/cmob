import type { NotificationAlertPayload } from "../protocol/rpc";
import {
  DEFAULT_LOCAL_NOTIFICATION_PREFS,
  type LocalNotificationPrefs,
} from "../domain/notificationCenter";

export { DEFAULT_LOCAL_NOTIFICATION_PREFS, type LocalNotificationPrefs };

const STORAGE_KEY = "cmux_local_notif_prefs";
const PREFS_EVENT = "cmux:local-notif-prefs-changed";

export function loadLocalNotificationPrefs(): LocalNotificationPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_LOCAL_NOTIFICATION_PREFS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LOCAL_NOTIFICATION_PREFS };
    const parsed = JSON.parse(raw) as Partial<LocalNotificationPrefs>;
    return {
      inAppToast:
        typeof parsed.inAppToast === "boolean"
          ? parsed.inAppToast
          : DEFAULT_LOCAL_NOTIFICATION_PREFS.inAppToast,
      desktopBrowserNotif:
        typeof parsed.desktopBrowserNotif === "boolean"
          ? parsed.desktopBrowserNotif
          : DEFAULT_LOCAL_NOTIFICATION_PREFS.desktopBrowserNotif,
      suppressWhileViewing:
        typeof parsed.suppressWhileViewing === "boolean"
          ? parsed.suppressWhileViewing
          : DEFAULT_LOCAL_NOTIFICATION_PREFS.suppressWhileViewing,
    };
  } catch {
    return { ...DEFAULT_LOCAL_NOTIFICATION_PREFS };
  }
}

export function saveLocalNotificationPrefs(prefs: LocalNotificationPrefs): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: prefs }));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function subscribeLocalNotificationPrefs(
  listener: (prefs: LocalNotificationPrefs) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (ev: Event) => {
    const detail = (ev as CustomEvent<LocalNotificationPrefs>).detail;
    if (detail) listener(detail);
  };
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === STORAGE_KEY) listener(loadLocalNotificationPrefs());
  };
  window.addEventListener(PREFS_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREFS_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export function isAlertSuppressedForView(
  prefs: LocalNotificationPrefs,
  alertSurfaceId: string,
  viewingSurfaceId: string | null,
  tabVisible: boolean,
): boolean {
  return Boolean(
    prefs.suppressWhileViewing &&
    tabVisible &&
    viewingSurfaceId &&
    viewingSurfaceId === alertSurfaceId,
  );
}

export function parseNotificationAlert(data: unknown): NotificationAlertPayload | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (
    typeof obj.notification_id !== "string" ||
    typeof obj.surface_id !== "string" ||
    typeof obj.title !== "string" ||
    typeof obj.body !== "string"
  ) {
    return null;
  }
  return {
    notification_id: obj.notification_id,
    surface_id: obj.surface_id,
    workspace_id: typeof obj.workspace_id === "string" ? obj.workspace_id : undefined,
    category: typeof obj.category === "string" ? obj.category : "turn-finished",
    agent: typeof obj.agent === "string" ? obj.agent : "agent",
    agent_display: typeof obj.agent_display === "string" ? obj.agent_display : undefined,
    title: obj.title,
    subtitle: typeof obj.subtitle === "string" ? obj.subtitle : null,
    body: obj.body,
    tag: typeof obj.tag === "string" ? obj.tag : "cmux-agent",
    urgent: Boolean(obj.urgent),
  };
}
