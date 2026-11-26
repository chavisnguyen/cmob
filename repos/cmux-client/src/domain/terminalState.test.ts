import { describe, expect, it } from "vite-plus/test";
import { convertRenderGridToAnsi } from "../components/terminal/renderGridToAnsi";
import { DEFAULT_LOCAL_NOTIFICATION_PREFS } from "../notifications/localPrefs";
import type { NotificationAlertPayload, RenderGridData } from "../protocol/rpc";
import {
  isSurfaceAlertSuppressed,
  reduceNotificationToasts,
  shouldTriggerBrowserNotification,
} from "./notificationCenter";
import {
  accumulateWheelLines,
  applyStickyModifiersToText,
  computeRenderGridFingerprint,
  encodeAccessoryKey,
  loadSavedViewportMode,
} from "./terminalState";

describe("terminalState & notificationCenter domain rules", () => {
  const baseGrid: RenderGridData = {
    active_screen: "primary",
    columns: 80,
    rows: 24,
    render_epoch: "ep-1",
    render_revision: 5,
    row_space_revision: 2,
    state_seq: 11,
    scrollback_rows: 10,
    cursor: { row: 4, column: 8, visible: true, style: "block", blinking: false },
    row_spans: [{ row: 0, column: 0, style_id: 0, text: "$ ls" }],
  };

  it("computes full render_grid fingerprint tracking cursor, scrollback, and row_space_revision", () => {
    const fpBase = computeRenderGridFingerprint(baseGrid, { mode: "mobile" });
    expect(computeRenderGridFingerprint({ ...baseGrid }, { mode: "mobile" })).toBe(fpBase);

    expect(
      computeRenderGridFingerprint(
        { ...baseGrid, cursor: { ...baseGrid.cursor!, column: 9 } },
        { mode: "mobile" },
      ),
    ).not.toBe(fpBase);

    expect(
      computeRenderGridFingerprint(
        { ...baseGrid, cursor: { ...baseGrid.cursor!, visible: false } },
        { mode: "mobile" },
      ),
    ).not.toBe(fpBase);

    expect(
      computeRenderGridFingerprint(
        { ...baseGrid, cursor: { ...baseGrid.cursor!, style: "bar" } },
        { mode: "mobile" },
      ),
    ).not.toBe(fpBase);

    expect(
      computeRenderGridFingerprint({ ...baseGrid, scrollback_rows: 11 }, { mode: "mobile" }),
    ).not.toBe(fpBase);

    expect(
      computeRenderGridFingerprint({ ...baseGrid, row_space_revision: 3 }, { mode: "mobile" }),
    ).not.toBe(fpBase);
  });

  it("encodes sticky Ctrl and Alt modifiers on arrow keys in both accessory bar and xterm onData", () => {
    expect(encodeAccessoryKey("up", false, "once", "off")).toBe("\x1b[1;5A");
    expect(encodeAccessoryKey("down", true, "locked", "off")).toBe("\x1b[1;5B");
    expect(encodeAccessoryKey("right", false, "off", "once")).toBe("\x1b[1;3C");
    expect(encodeAccessoryKey("left", true, "once", "once")).toBe("\x1b[1;7D");

    expect(applyStickyModifiersToText("\x1b[A", "once", "off")).toBe("\x1b[1;5A");
    expect(applyStickyModifiersToText("\x1bOB", "off", "once")).toBe("\x1b[1;3B");
    expect(applyStickyModifiersToText("\x1b[D", "locked", "once")).toBe("\x1b[1;7D");
  });

  it("accumulates 120Hz 1px trackpad wheel deltas cleanly without flooding scroll RPCs", () => {
    let acc = 0;
    let totalEmittedLines = 0;
    for (let frame = 0; frame < 15; frame += 1) {
      const step = accumulateWheelLines(acc, 1, 16);
      expect(step.lines).toBe(0);
      acc = step.remainderPx;
    }
    const sixteenth = accumulateWheelLines(acc, 1, 16);
    totalEmittedLines += sixteenth.lines;
    expect(totalEmittedLines).toBe(1);
    expect(sixteenth.remainderPx).toBe(0);
  });

  it("defaults terminal viewport mode to desktop on desktop and mobile on mobile", () => {
    const emptyStorage = { getItem: () => null };
    expect(loadSavedViewportMode(true, emptyStorage)).toBe("desktop");
    expect(loadSavedViewportMode(false, emptyStorage)).toBe("mobile");
  });

  it("emits DECCKM (?1h/?1l) and bracketed paste (?2004h/?2004l) ANSI sequences", () => {
    const onAnsi = convertRenderGridToAnsi({
      active_screen: "primary",
      columns: 80,
      rows: 24,
      modes: [
        { ansi: false, code: 1, on: true },
        { ansi: false, code: 2004, on: true },
      ],
    }).ansiPayload;
    expect(onAnsi).toContain("\x1b[?1h");
    expect(onAnsi).toContain("\x1b[?2004h");

    const offAnsi = convertRenderGridToAnsi({
      active_screen: "primary",
      columns: 80,
      rows: 24,
      modes: [],
    }).ansiPayload;
    expect(offAnsi).toContain("\x1b[?1l");
    expect(offAnsi).toContain("\x1b[?2004l");
  });

  it("tracks evicted toast timer IDs across tag replacement, 3-toast overflow, and id/ref dismissal", () => {
    const makeAlert = (
      id: string,
      tag: string,
      surfaceId = "surf-1",
    ): NotificationAlertPayload => ({
      notification_id: id,
      surface_id: surfaceId,
      category: "turn-finished",
      agent: "claude",
      title: id,
      body: "done",
      tag,
      urgent: false,
    });

    let state = reduceNotificationToasts([], { type: "add", alert: makeAlert("n1", "t1") });
    state = reduceNotificationToasts(state.toasts, { type: "add", alert: makeAlert("n2", "t2") });
    state = reduceNotificationToasts(state.toasts, { type: "add", alert: makeAlert("n3", "t3") });
    expect(state.evictedIds).toEqual([]);

    // 4th distinct tag evicts oldest (n1)
    const overflow = reduceNotificationToasts(state.toasts, {
      type: "add",
      alert: makeAlert("n4", "t4"),
    });
    expect(overflow.toasts.map((t) => t.notification_id)).toEqual(["n4", "n3", "n2"]);
    expect(overflow.evictedIds).toEqual(["n1"]);

    // Same tag replaces n3 and reports n3 in evictedIds
    const replaced = reduceNotificationToasts(overflow.toasts, {
      type: "add",
      alert: makeAlert("n5", "t3", "surface:ref-9"),
    });
    expect(replaced.evictedIds).toEqual(["n3"]);

    // Dismissing by surface matches `ref` as well as `id`
    const dismissedByRef = reduceNotificationToasts(replaced.toasts, {
      type: "dismiss_for_surface",
      surface: { id: "uuid-9", ref: "surface:ref-9" },
    });
    expect(dismissedByRef.evictedIds).toEqual(["n5"]);

    expect(
      isSurfaceAlertSuppressed({
        prefs: DEFAULT_LOCAL_NOTIFICATION_PREFS,
        alertSurfaceId: "surface:ref-9",
        viewingSurface: { id: "uuid-9", ref: "surface:ref-9" },
        isViewingSurface: true,
        tabVisible: true,
      }),
    ).toBe(true);

    expect(
      shouldTriggerBrowserNotification({
        prefs: DEFAULT_LOCAL_NOTIFICATION_PREFS,
        tabVisible: false,
        permission: "granted",
      }),
    ).toBe(true);
    expect(
      shouldTriggerBrowserNotification({
        prefs: DEFAULT_LOCAL_NOTIFICATION_PREFS,
        tabVisible: true,
        permission: "granted",
      }),
    ).toBe(false);
  });
});
