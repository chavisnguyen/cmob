import { describe, expect, it } from "vite-plus/test";
import { createRpcRequest, RPC_METHODS, type RenderGridData } from "../../protocol/rpc";
import { convertRenderGridToAnsi, extractGridModes } from "./renderGridToAnsi";
import {
  applyStickyModifiersToText,
  clampDesktopPan,
  computeDesktopFitScale,
  computeMobileGridDimensions,
  consumeStickyLatch,
  encodeAccessoryKey,
  transitionStickyLatch,
  type StickyModifierLatch,
} from "./terminalViewport";

describe("Terminal Viewport, Sticky Modifiers & RenderGrid Conversion", () => {
  it("transitions sticky modifier latch across single and double taps", () => {
    let latch: StickyModifierLatch = "off";
    latch = transitionStickyLatch(latch, false);
    expect(latch).toBe("once");

    latch = transitionStickyLatch(latch, false);
    expect(latch).toBe("off");

    latch = transitionStickyLatch(latch, true);
    expect(latch).toBe("locked");

    latch = consumeStickyLatch(latch);
    expect(latch).toBe("locked");

    latch = transitionStickyLatch("once", false);
    expect(latch).toBe("off");
    expect(consumeStickyLatch("once")).toBe("off");
  });

  it("computes mobile grid cols and rows from container and cell metrics", () => {
    expect(
      computeMobileGridDimensions({
        viewportWidth: 360,
        viewportHeight: 400,
        cellWidth: 8,
        cellHeight: 16,
      }),
    ).toEqual({ cols: 45, rows: 25 });

    expect(
      computeMobileGridDimensions({
        viewportWidth: 100,
        viewportHeight: 80,
        cellWidth: 8,
        cellHeight: 16,
      }),
    ).toEqual({ cols: 20, rows: 8 });
  });

  it("computes Orca desktop fit scale with near-one snapping and pan clamping", () => {
    expect(
      computeDesktopFitScale({
        viewportWidth: 390,
        cols: 120,
        cellWidth: 7.5,
      }),
    ).toBeCloseTo(390 / 900, 4);

    expect(
      computeDesktopFitScale({
        viewportWidth: 390,
        cols: 50,
        cellWidth: 8,
      }),
    ).toBe(1);

    expect(
      clampDesktopPan({
        panX: -500,
        panY: 40,
        contentWidth: 600,
        contentHeight: 400,
        viewportWidth: 300,
        viewportHeight: 300,
        totalScale: 1,
      }),
    ).toEqual({ panX: -300, panY: 0 });
  });

  it("encodes sticky Ctrl/Alt and DECCKM cursor keys accurately", () => {
    expect(applyStickyModifiersToText("c", "once", "off")).toBe("\x03");
    expect(applyStickyModifiersToText("x", "off", "once")).toBe("\x1bx");
    expect(applyStickyModifiersToText("d", "locked", "once")).toBe("\x1b\x04");
    expect(encodeAccessoryKey("up", false)).toBe("\x1b[A");
    expect(encodeAccessoryKey("up", true)).toBe("\x1bOA");
    expect(encodeAccessoryKey("shift+tab", false)).toBe("\x1b[Z");
  });

  it("converts cmux render_grid primary screen + scrollback + TrueColor styles to ANSI", () => {
    const grid: RenderGridData = {
      active_screen: "primary",
      columns: 40,
      rows: 2,
      scrollback_rows: 1,
      cursor: { row: 1, column: 2, style: "bar", blinking: true, visible: true },
      modes: [
        { ansi: false, code: 1, on: true },
        { ansi: false, code: 2004, on: true },
      ],
      styles: [
        {
          id: 1,
          foreground: "#ff8800",
          foreground_source: "rgb",
          background_source: "default",
          bold: true,
        },
      ],
      scrollback_spans: [{ row: 0, column: 0, style_id: 0, text: "older line" }],
      row_spans: [{ row: 0, column: 2, style_id: 1, text: "hi" }],
    };

    const converted = convertRenderGridToAnsi(grid);
    expect(converted.columns).toBe(40);
    expect(converted.rows).toBe(2);
    expect(converted.modes.altScreen).toBe(false);
    expect(converted.modes.applicationCursorKeysMode).toBe(true);
    expect(converted.modes.bracketedPasteMode).toBe(true);
    expect(converted.ansiPayload).toContain("\x1b[?2026h");
    expect(converted.ansiPayload).toContain("older line\r\n");
    expect(converted.ansiPayload).toContain("  \x1b[0;1;38;2;255;136;0mhi\x1b[0m\r\n");
    expect(converted.ansiPayload).toContain("\x1b[5 q\x1b[2;3H");
    expect(converted.ansiPayload).toContain("\x1b[?2026l");
  });

  it("extracts alternate screen and mouse modes from render_grid", () => {
    const modes = extractGridModes({
      active_screen: "alternate",
      columns: 80,
      rows: 24,
      modes: [
        { ansi: false, code: 1002, on: true },
        { ansi: false, code: 1006, on: true },
      ],
    });
    expect(modes.altScreen).toBe(true);
    expect(modes.mouseTrackingMode).toBe("button");
    expect(modes.sgrMouseMode).toBe(true);
  });

  it("formats mobile.terminal.viewport and mobile.terminal.input RPC requests", () => {
    const viewportReq = createRpcRequest(
      RPC_METHODS.TERMINAL_VIEWPORT,
      { surface_id: "surf-1", client_id: "pwa-1", mode: "mobile", columns: 45, rows: 24 },
      "req-vp",
    );
    expect(viewportReq.params).toEqual({
      surface_id: "surf-1",
      client_id: "pwa-1",
      mode: "mobile",
      columns: 45,
      rows: 24,
    });

    const inputReq = createRpcRequest(
      RPC_METHODS.TERMINAL_INPUT,
      { surface_id: "surf-1", text: "\x03", kind: "text" },
      "req-input",
    );
    expect(inputReq.params).toEqual({
      surface_id: "surf-1",
      text: "\x03",
      kind: "text",
    });
  });
});
