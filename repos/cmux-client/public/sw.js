/**
 * Service Worker for cmux-mobile PWA
 * Handles Web Push notifications (VAPID), automatic dismissal, and deep-linking to active sessions.
 * Conforms to RFC 8291 / RFC 8292 standards.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

async function closeNotificationsByTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return;
  const tagSet = new Set(tags.filter((t) => typeof t === "string" && t.length > 0));
  if (tagSet.size === 0) return;
  const open = await self.registration.getNotifications();
  for (const notification of open) {
    if (notification.tag && tagSet.has(notification.tag)) {
      notification.close();
    }
  }
}

self.addEventListener("push", (event) => {
  let payload = {
    title: "cmux Agent Alert",
    body: "Agent turn completed or awaiting approval.",
    tag: "cmux-agent",
    kind: "alert",
    tags: [],
    data: {},
  };

  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch {
      payload.body = event.data.text();
    }
  }

  if (payload.kind === "dismiss") {
    const tags =
      Array.isArray(payload.tags) && payload.tags.length > 0
        ? payload.tags
        : payload.tag
          ? [payload.tag]
          : [];
    event.waitUntil(closeNotificationsByTags(tags));
    return;
  }

  const category = payload.data?.category;
  const isPermission =
    category === "needs-permission" ||
    category === "cmux-dialog" ||
    payload.title?.toLowerCase().includes("approval") ||
    payload.title?.toLowerCase().includes("permission");
  const isUrgent = isPermission || category === "agent-error" || payload.data?.urgent === true;

  const actions = isPermission
    ? [
        { action: "approve", title: "Approve ⚡" },
        { action: "open", title: "Open Session" },
      ]
    : [{ action: "open", title: "View" }];

  const iconUrl = new URL("favicon.svg", self.registration.scope).href;
  const options = {
    body: payload.body,
    icon: iconUrl,
    badge: iconUrl,
    tag: payload.tag || "cmux-notification",
    data: payload.data || {},
    actions,
    requireInteraction: isPermission,
    renotify: isUrgent,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "cmux.notification.dismiss") {
    event.waitUntil(closeNotificationsByTags(event.data.tags));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const surfaceId = data.surfaceId;
  const targetUrl = new URL(
    surfaceId ? `?surface=${encodeURIComponent(surfaceId)}` : "./",
    self.registration.scope,
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if (client.url.startsWith(self.registration.scope)) {
            client.postMessage({
              type: "cmux.notification.clicked",
              action: event.action,
              data,
            });
            return client.focus();
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
