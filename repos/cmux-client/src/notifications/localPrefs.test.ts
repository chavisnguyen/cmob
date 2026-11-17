import { describe, it, expect, beforeEach } from "vite-plus/test";
import {
  DEFAULT_LOCAL_NOTIFICATION_PREFS,
  isAlertSuppressedForView,
  loadLocalNotificationPrefs,
  parseNotificationAlert,
  saveLocalNotificationPrefs,
} from "./localPrefs";

describe("localPrefs", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
  });

  it("defaults all local notification options to enabled", () => {
    expect(loadLocalNotificationPrefs()).toEqual(DEFAULT_LOCAL_NOTIFICATION_PREFS);
  });

  it("persists and reloads local notification preferences", () => {
    if (typeof localStorage === "undefined") return;
    saveLocalNotificationPrefs({
      inAppToast: false,
      desktopBrowserNotif: true,
      suppressWhileViewing: false,
    });
    expect(loadLocalNotificationPrefs()).toEqual({
      inAppToast: false,
      desktopBrowserNotif: true,
      suppressWhileViewing: false,
    });
  });

  it("suppresses alerts only when actively viewing the matching surface with suppressWhileViewing", () => {
    expect(
      isAlertSuppressedForView(DEFAULT_LOCAL_NOTIFICATION_PREFS, "surf-1", "surf-1", true),
    ).toBe(true);
    expect(
      isAlertSuppressedForView(DEFAULT_LOCAL_NOTIFICATION_PREFS, "surf-1", "surf-2", true),
    ).toBe(false);
    expect(
      isAlertSuppressedForView(DEFAULT_LOCAL_NOTIFICATION_PREFS, "surf-1", "surf-1", false),
    ).toBe(false);
    expect(
      isAlertSuppressedForView(
        { ...DEFAULT_LOCAL_NOTIFICATION_PREFS, suppressWhileViewing: false },
        "surf-1",
        "surf-1",
        true,
      ),
    ).toBe(false);
  });

  it("validates notification alert payloads", () => {
    expect(parseNotificationAlert(null)).toBeNull();
    expect(parseNotificationAlert({ surface_id: "s1" })).toBeNull();
    expect(
      parseNotificationAlert({
        notification_id: "n-1",
        surface_id: "surf-1",
        category: "needs-permission",
        agent: "claude",
        title: "cmux-mobile - Claude needs approval",
        body: "Approve tool: Bash",
        tag: "cmux_p_surf-1",
        urgent: true,
      }),
    ).toMatchObject({
      notification_id: "n-1",
      surface_id: "surf-1",
      urgent: true,
    });
  });
});
