import type { NotificationAlertPayload, SurfaceNode } from "../protocol/rpc";
import { matchesSurfaceId } from "./workspaceTree";

export interface LocalNotificationPrefs {
  inAppToast: boolean;
  desktopBrowserNotif: boolean;
  suppressWhileViewing: boolean;
}

export const DEFAULT_LOCAL_NOTIFICATION_PREFS: LocalNotificationPrefs = {
  inAppToast: true,
  desktopBrowserNotif: true,
  suppressWhileViewing: true,
};

export const MAX_ACTIVE_TOASTS = 3;
export const TOAST_DURATION_MS = 8_000;

export type NotificationToastAction =
  | { type: "add"; alert: NotificationAlertPayload; maxToasts?: number }
  | { type: "dismiss_by_id"; notificationId: string }
  | { type: "dismiss_by_tags"; surfaceId: string; tags: readonly string[] }
  | {
      type: "dismiss_for_surface";
      surface: Pick<SurfaceNode, "id" | "ref"> | string;
    }
  | { type: "clear" };

export interface NotificationToastTransition {
  toasts: NotificationAlertPayload[];
  /** IDs of all replaced, overflow-evicted, or dismissed toasts whose timers must be cleared. */
  evictedIds: string[];
}

function toastMatchesTargetSurface(
  toastSurfaceId: string,
  target: Pick<SurfaceNode, "id" | "ref"> | string,
): boolean {
  if (typeof target === "string") {
    return Boolean(target) && toastSurfaceId === target;
  }
  return matchesSurfaceId(target, toastSurfaceId);
}

/**
 * Pure toast list reducer returning `{ toasts, evictedIds }` so callers clear `setTimeout`
 * handles for every tag-replaced, `slice(0, max)`-evicted, or dismissed notification.
 */
export function reduceNotificationToasts(
  prev: readonly NotificationAlertPayload[],
  action: NotificationToastAction,
): NotificationToastTransition {
  switch (action.type) {
    case "add": {
      const cap = Math.max(1, action.maxToasts ?? MAX_ACTIVE_TOASTS);
      const evictedIds: string[] = [];
      const kept: NotificationAlertPayload[] = [];

      for (const existing of prev) {
        if (
          existing.tag === action.alert.tag ||
          existing.notification_id === action.alert.notification_id
        ) {
          evictedIds.push(existing.notification_id);
        } else {
          kept.push(existing);
        }
      }

      const combined = [action.alert, ...kept];
      const toasts = combined.slice(0, cap);
      for (let i = cap; i < combined.length; i += 1) {
        evictedIds.push(combined[i].notification_id);
      }

      return { toasts, evictedIds };
    }

    case "dismiss_by_id": {
      if (prev.length === 0) return { toasts: [], evictedIds: [] };
      const evictedIds: string[] = [];
      const toasts = prev.filter((t) => {
        if (t.notification_id === action.notificationId) {
          evictedIds.push(t.notification_id);
          return false;
        }
        return true;
      });
      return { toasts, evictedIds };
    }

    case "dismiss_by_tags": {
      if (prev.length === 0 || action.tags.length === 0) {
        return { toasts: [...prev], evictedIds: [] };
      }
      const tagSet = new Set(action.tags);
      const evictedIds: string[] = [];
      const toasts = prev.filter((t) => {
        if (t.surface_id === action.surfaceId && tagSet.has(t.tag)) {
          evictedIds.push(t.notification_id);
          return false;
        }
        return true;
      });
      return { toasts, evictedIds };
    }

    case "dismiss_for_surface": {
      if (prev.length === 0) return { toasts: [], evictedIds: [] };
      const evictedIds: string[] = [];
      const toasts = prev.filter((t) => {
        if (toastMatchesTargetSurface(t.surface_id, action.surface)) {
          evictedIds.push(t.notification_id);
          return false;
        }
        return true;
      });
      return { toasts, evictedIds };
    }

    case "clear": {
      if (prev.length === 0) return { toasts: [], evictedIds: [] };
      return {
        toasts: [],
        evictedIds: prev.map((t) => t.notification_id),
      };
    }
  }
}

/**
 * Checks whether an incoming alert is suppressed because the user is actively looking at that
 * exact surface (matching either `surface.id` or `surface.ref`).
 */
export function isSurfaceAlertSuppressed(params: {
  prefs: LocalNotificationPrefs;
  alertSurfaceId: string;
  viewingSurface: Pick<SurfaceNode, "id" | "ref"> | null;
  isViewingSurface: boolean;
  tabVisible: boolean;
}): boolean {
  const { prefs, alertSurfaceId, viewingSurface, isViewingSurface, tabVisible } = params;
  if (!prefs.suppressWhileViewing || !tabVisible || !isViewingSurface || !viewingSurface) {
    return false;
  }
  return matchesSurfaceId(viewingSurface, alertSurfaceId);
}

/**
 * Computes whether to fire a system browser `Notification` when the app tab is hidden.
 */
export function shouldTriggerBrowserNotification(params: {
  prefs: LocalNotificationPrefs;
  tabVisible: boolean;
  permission: NotificationPermission;
}): boolean {
  return Boolean(
    !params.tabVisible && params.prefs.desktopBrowserNotif && params.permission === "granted",
  );
}

/** Notification bodies carry raw agent markdown; format them cleanly as plain text. */
export function plainNotificationBody(md: string): string {
  return md
    .replace(/^\s*-\s+/gm, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
