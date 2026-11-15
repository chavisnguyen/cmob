/**
 * Service Worker for cmux-mobile PWA
 * Handles Web Push notifications (VAPID) and deep-linking to active sessions.
 * Conforms to RFC 8291 / RFC 8292 standards.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "cmux Agent Alert",
    body: "Agent turn completed or awaiting approval.",
    tag: "cmux-agent",
    data: {},
  };

  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch {
      payload.body = event.data.text();
    }
  }

  const isPermission =
    payload.data?.category === "needs-permission" ||
    payload.title?.toLowerCase().includes("approval") ||
    payload.title?.toLowerCase().includes("permission");

  const actions = isPermission
    ? [
        { action: "approve", title: "Approve ⚡" },
        { action: "open", title: "Open Session" },
      ]
    : [{ action: "open", title: "View" }];

  const options = {
    body: payload.body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: payload.tag || "cmux-notification",
    data: payload.data || {},
    actions,
    requireInteraction: isPermission,
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const surfaceId = data.surfaceId;
  const targetUrl = surfaceId ? `/?surface=${encodeURIComponent(surfaceId)}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if (client.url.includes(self.location.origin)) {
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
