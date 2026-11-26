import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  accumulateWheelLines,
  applyStickyModifiersToText,
  computeRenderGridFingerprint,
  normalizeWheelDeltaPx,
  type StickyModifierLatch,
  type TerminalViewportMode,
} from "../../domain/terminalState";
import type { RenderGridData, TerminalReplayPayload } from "../../protocol/rpc";
import { convertRenderGridToAnsi, type TerminalGridModes } from "./renderGridToAnsi";
import { readXtermCellMetrics, useTerminalViewportGestures } from "./useTerminalViewportGestures";

export { readXtermCellMetrics };

const FIXED_FONT_SIZE = 12;
const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export function useXtermInstance({
  surfaceId,
  viewportMode,
  viewportModeRef,
  ctrlLatchRef,
  altLatchRef,
  consumeLatches,
  onSendBytes,
  onSendPaste,
  onSendScroll,
  onSyncMobileViewport,
}: {
  surfaceId: string;
  viewportMode: TerminalViewportMode;
  viewportModeRef: React.RefObject<TerminalViewportMode>;
  ctrlLatchRef: React.RefObject<StickyModifierLatch>;
  altLatchRef: React.RefObject<StickyModifierLatch>;
  consumeLatches: () => void;
  onSendBytes: (bytes: string) => Promise<void>;
  onSendPaste: (text: string) => Promise<void>;
  onSendScroll: (deltaLines: number) => Promise<void>;
  onSyncMobileViewport: () => void;
}) {
  const [gridDims, setGridDims] = useState<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const [showScrollBottomPill, setShowScrollBottomPill] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const surfaceHostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  const modesRef = useRef<TerminalGridModes>({
    altScreen: false,
    applicationCursorKeysMode: false,
    bracketedPasteMode: false,
    mouseTrackingMode: "none",
    sgrMouseMode: false,
    sgrMousePixelsMode: false,
  });
  const shouldAutoScrollRef = useRef(true);
  const isWritingGridRef = useRef(false);
  const lastAppliedKeyRef = useRef("");
  const lastThemeKeyRef = useRef("");
  const wheelAccPxRef = useRef(0);

  const {
    fitScale,
    userScale,
    panOffset,
    measureMobileGrid,
    recomputeDesktopTransform,
    resetDesktopZoom,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useTerminalViewportGestures({
    viewportRef,
    termRef,
    modesRef,
    viewportMode,
    viewportModeRef,
    onSendScroll,
    onSyncMobileViewport,
  });

  const applyReplayPayload = useCallback(
    (payload: TerminalReplayPayload | undefined) => {
      if (!payload) return;
      if (payload.surface_id && payload.surface_id !== surfaceId) return;
      const term = termRef.current;
      if (!term || !payload.render_grid) return;

      const grid: RenderGridData = payload.render_grid;
      const frameKey = computeRenderGridFingerprint(grid, payload);
      if (frameKey === lastAppliedKeyRef.current) return;
      lastAppliedKeyRef.current = frameKey;

      const converted = convertRenderGridToAnsi(grid);
      modesRef.current = converted.modes;
      const themeKey = `${converted.theme.foreground ?? ""}:${converted.theme.background ?? ""}:${converted.theme.cursor ?? ""}`;
      if (themeKey !== lastThemeKeyRef.current) {
        lastThemeKeyRef.current = themeKey;
        term.options.theme = converted.theme;
      }

      const activeBuffer = term.buffer.active;
      const wasAtBottom = activeBuffer.viewportY >= activeBuffer.baseY - 1;
      const savedViewportY = activeBuffer.viewportY;

      isWritingGridRef.current = true;
      if (term.cols !== converted.columns || term.rows !== converted.rows) {
        term.resize(converted.columns, converted.rows);
      }
      setGridDims((prev) =>
        prev.cols === converted.columns && prev.rows === converted.rows
          ? prev
          : { cols: converted.columns, rows: converted.rows },
      );

      term.write(converted.ansiPayload, () => {
        if (converted.modes.altScreen) {
          shouldAutoScrollRef.current = true;
          setShowScrollBottomPill(false);
        } else if (shouldAutoScrollRef.current || wasAtBottom) {
          term.scrollToBottom();
          setShowScrollBottomPill(false);
        } else {
          const clampedLine = Math.min(savedViewportY, term.buffer.active.baseY);
          term.scrollToLine(clampedLine);
          setShowScrollBottomPill(term.buffer.active.baseY > 0);
        }
        isWritingGridRef.current = false;
        recomputeDesktopTransform(converted.columns);
      });
    },
    [surfaceId, recomputeDesktopTransform],
  );

  useEffect(() => {
    const host = surfaceHostRef.current;
    if (!host) return;
    lastAppliedKeyRef.current = "";
    shouldAutoScrollRef.current = true;
    wheelAccPxRef.current = 0;
    setShowScrollBottomPill(false);

    const term = new XtermTerminal({
      allowProposedApi: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: FIXED_FONT_SIZE,
      lineHeight: 1.25,
      scrollback: 500,
      cursorBlink: true,
      convertEol: false,
      disableStdin: false,
      theme: { background: "#141413", foreground: "#ededeb", cursor: "#ededeb" },
    });

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";
    term.open(host);

    let disposed = false;
    let webglAddon: { dispose: () => void } | null = null;
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed) return;
        try {
          const addon = new WebglAddon();
          addon.onContextLoss(() => {
            addon.dispose();
            if (webglAddon === addon) webglAddon = null;
          });
          term.loadAddon(addon);
          webglAddon = addon;
        } catch {
          webglAddon = null;
        }
      })
      .catch(() => {});

    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      shouldAutoScrollRef.current = true;
      void onSendPaste(text);
    };
    host.addEventListener("paste", onPaste, { capture: true });

    const dataDisposable = term.onData((rawData) => {
      const bytes = applyStickyModifiersToText(rawData, ctrlLatchRef.current, altLatchRef.current);
      consumeLatches();
      shouldAutoScrollRef.current = true;
      void onSendBytes(bytes);
    });

    const scrollDisposable = term.onScroll(() => {
      if (isWritingGridRef.current) return;
      if (modesRef.current.altScreen) {
        setShowScrollBottomPill(false);
        return;
      }
      const activeBuffer = term.buffer.active;
      const atBottom = activeBuffer.viewportY >= activeBuffer.baseY - 1;
      shouldAutoScrollRef.current = atBottom;
      setShowScrollBottomPill(!atBottom && activeBuffer.baseY > 0);
    });

    term.attachCustomWheelEventHandler((wheelEvent) => {
      if (modesRef.current.altScreen || modesRef.current.mouseTrackingMode !== "none") {
        const deltaPx = normalizeWheelDeltaPx(wheelEvent.deltaY, wheelEvent.deltaMode, 16);
        const { lines, remainderPx } = accumulateWheelLines(wheelAccPxRef.current, deltaPx, 16);
        wheelAccPxRef.current = remainderPx;
        if (lines !== 0) {
          void onSendScroll(lines);
        }
        return false;
      }
      return true;
    });

    termRef.current = term;
    requestAnimationFrame(() => recomputeDesktopTransform());

    return () => {
      disposed = true;
      host.removeEventListener("paste", onPaste, { capture: true });
      dataDisposable.dispose();
      scrollDisposable.dispose();
      webglAddon?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [
    surfaceId,
    ctrlLatchRef,
    altLatchRef,
    consumeLatches,
    onSendBytes,
    onSendPaste,
    onSendScroll,
    recomputeDesktopTransform,
  ]);

  const scrollToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true;
    termRef.current?.scrollToBottom();
    setShowScrollBottomPill(false);
  }, []);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const dismissKeyboard = useCallback(() => {
    termRef.current?.blur();
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  const resetLastAppliedKey = useCallback(() => {
    lastAppliedKeyRef.current = "";
  }, []);

  const enableAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = true;
  }, []);

  const getApplicationCursorKeysMode = useCallback(
    () => modesRef.current.applicationCursorKeysMode,
    [],
  );

  return {
    viewportRef,
    surfaceHostRef,
    gridDims,
    showScrollBottomPill,
    fitScale,
    userScale,
    panOffset,
    measureMobileGrid,
    applyReplayPayload,
    resetLastAppliedKey,
    enableAutoScroll,
    getApplicationCursorKeysMode,
    recomputeDesktopTransform,
    resetDesktopZoom,
    scrollToBottom,
    focusTerminal,
    dismissKeyboard,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
