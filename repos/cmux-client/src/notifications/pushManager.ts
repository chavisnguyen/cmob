/**
 * Web Push and Service Worker Manager for cmux-mobile PWA
 * Follows RFC 8291 / RFC 8292 (VAPID) specifications.
 */

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export class PushManager {
  private swRegistration: ServiceWorkerRegistration | null = null;

  /**
   * Registers the Service Worker at /sw.js
   */
  async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      console.warn("Service Workers not supported in this environment");
      return null;
    }

    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      this.swRegistration = reg;
      return reg;
    } catch (err) {
      console.error("Failed to register Service Worker:", err);
      return null;
    }
  }

  /**
   * Checks if running inside an iOS device
   */
  isIos(): boolean {
    if (typeof navigator === "undefined") return false;
    const userAgent = navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  }

  /**
   * Checks if running in standalone PWA mode (installed to Home Screen)
   */
  isStandalone(): boolean {
    if (typeof window === "undefined" || typeof navigator === "undefined") return false;
    const isStandaloneDisplay = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
    const isNavigatorStandalone =
      "standalone" in navigator && Boolean((navigator as { standalone?: boolean }).standalone);
    return isStandaloneDisplay || isNavigatorStandalone;
  }

  /**
   * iOS Web Push requires the app to be installed to Home Screen (PWA standalone mode).
   * Returns true if user is on iOS Safari but hasn't added to Home Screen yet.
   */
  needsIosPwaInstall(): boolean {
    return this.isIos() && !this.isStandalone();
  }

  /**
   * Checks current Notification permission
   */
  getPermission(): NotificationPermission {
    if (typeof Notification === "undefined") return "denied";
    return Notification.permission;
  }

  /**
   * Requests permission to display notifications
   */
  async requestPermission(): Promise<NotificationPermission> {
    if (typeof Notification === "undefined") {
      throw new Error("Notifications are not supported in this browser");
    }
    return await Notification.requestPermission();
  }

  /**
   * Subscribes to Web Push using the Gateway's VAPID Public Key
   */
  async subscribe(vapidPublicKey: string): Promise<PushSubscriptionData | null> {
    const reg = this.swRegistration || (await this.registerServiceWorker());
    if (!reg) throw new Error("Service Worker not active");

    const convertedVapidKey = this.urlBase64ToUint8Array(vapidPublicKey);
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      try {
        const currentKey = existing.options.applicationServerKey;
        if (currentKey) {
          const currentArr = new Uint8Array(currentKey);
          let match = currentArr.length === convertedVapidKey.length;
          if (match) {
            for (let i = 0; i < currentArr.length; i++) {
              if (currentArr[i] !== convertedVapidKey[i]) {
                match = false;
                break;
              }
            }
          }
          if (!match) {
            await existing.unsubscribe();
          }
        }
      } catch {
        await existing.unsubscribe().catch(() => {});
      }
    }

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey as unknown as BufferSource,
    });

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error("Invalid push subscription structure returned by browser");
    }

    return {
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    };
  }

  /** Endpoint of this browser's current push subscription, or null when not subscribed. */
  async getEndpoint(): Promise<string | null> {
    try {
      const reg = this.swRegistration ?? (await navigator.serviceWorker?.getRegistration("/"));
      const sub = await reg?.pushManager.getSubscription();
      return sub?.endpoint ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Unsubscribes from Web Push
   */
  async unsubscribe(): Promise<boolean> {
    if (!this.swRegistration) return false;
    const sub = await this.swRegistration.pushManager.getSubscription();
    if (sub) {
      return await sub.unsubscribe();
    }
    return false;
  }

  /**
   * Helper to convert base64url VAPID public key to Uint8Array for PushManager
   */
  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const decodeBase64 =
      typeof atob === "function"
        ? atob
        : (globalThis as unknown as { atob?: (s: string) => string }).atob;
    const rawData = decodeBase64 ? decodeBase64(base64) : "";
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
}

export const pushManager = new PushManager();
