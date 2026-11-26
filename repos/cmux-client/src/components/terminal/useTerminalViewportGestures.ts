import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import {
  clampDesktopPan,
  computeDesktopFitScale,
  computeMobileGridDimensions,
  type TerminalViewportMode,
} from "../../domain/terminalState";
import { XTERM_PADDING_PX } from "../../state/useTerminalController";
import type { TerminalGridModes } from "./renderGridToAnsi";

const DEFAULT_CELL_WIDTH = 7.2;
const DEFAULT_CELL_HEIGHT = 15.6;

interface XtermWithCore {
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: { width?: number; height?: number };
        };
      };
    };
  };
}

export function readXtermCellMetrics(term: XtermTerminal | null): {
  cellWidth: number;
  cellHeight: number;
} {
  if (!term) return { cellWidth: DEFAULT_CELL_WIDTH, cellHeight: DEFAULT_CELL_HEIGHT };
  const cell = (term as unknown as XtermWithCore)._core?._renderService?.dimensions?.css?.cell;
  return {
    cellWidth: cell?.width && cell.width > 0 ? cell.width : DEFAULT_CELL_WIDTH,
    cellHeight: cell?.height && cell.height > 0 ? cell.height : DEFAULT_CELL_HEIGHT,
  };
}

export function useTerminalViewportGestures({
  viewportRef,
  termRef,
  modesRef,
  viewportMode,
  viewportModeRef,
  onSendScroll,
  onSyncMobileViewport,
}: {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  termRef: React.RefObject<XtermTerminal | null>;
  modesRef: React.RefObject<TerminalGridModes>;
  viewportMode: TerminalViewportMode;
  viewportModeRef: React.RefObject<TerminalViewportMode>;
  onSendScroll: (deltaLines: number) => Promise<void>;
  onSyncMobileViewport: () => void;
}) {
  const [fitScale, setFitScale] = useState(1);
  const [userScale, setUserScale] = useState(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const scrollAccRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchGestureRafRef = useRef(0);
  const pendingTouchStateRef = useRef<{ scale?: number; panX: number; panY: number } | null>(null);
  const userScaleRef = useRef(1);
  const fitScaleRef = useRef(1);
  const panOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const gestureRef = useRef({
    mode: "none" as "none" | "pan" | "pinch",
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    startDistance: 0,
    startUserScale: 1,
    moved: false,
  });

  useEffect(() => {
    userScaleRef.current = userScale;
  }, [userScale]);
  useEffect(() => {
    fitScaleRef.current = fitScale;
  }, [fitScale]);
  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);

  const measureMobileGrid = useCallback((): { cols: number; rows: number } | null => {
    const container = viewportRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { cellWidth, cellHeight } = readXtermCellMetrics(termRef.current);
    return computeMobileGridDimensions({
      viewportWidth: rect.width - XTERM_PADDING_PX * 2,
      viewportHeight: rect.height - XTERM_PADDING_PX * 2,
      cellWidth,
      cellHeight,
    });
  }, [viewportRef, termRef]);

  const recomputeDesktopTransform = useCallback(
    (colsOverride?: number) => {
      const container = viewportRef.current;
      const term = termRef.current;
      if (!container || !term) return;

      if (viewportModeRef.current === "mobile") {
        if (fitScaleRef.current !== 1) setFitScale(1);
        if (userScaleRef.current !== 1) setUserScale(1);
        if (panOffsetRef.current.x !== 0 || panOffsetRef.current.y !== 0) {
          setPanOffset({ x: 0, y: 0 });
        }
        return;
      }

      const rect = container.getBoundingClientRect();
      const { cellWidth } = readXtermCellMetrics(term);
      const cols = colsOverride ?? term.cols;
      const screenWidth =
        term.element?.querySelector<HTMLElement>(".xterm-screen")?.offsetWidth ?? 0;
      const scrollWidth = term.element?.scrollWidth ?? 0;
      const nextFitScale = computeDesktopFitScale({
        viewportWidth: rect.width,
        cols,
        cellWidth: screenWidth > 0 ? 0 : cellWidth,
        scrollWidth: screenWidth > 0 ? screenWidth + XTERM_PADDING_PX * 2 : scrollWidth,
      });
      if (Math.abs(fitScaleRef.current - nextFitScale) > 0.001) setFitScale(nextFitScale);

      const clamped = clampDesktopPan({
        panX: panOffsetRef.current.x,
        panY: panOffsetRef.current.y,
        contentWidth: term.element?.scrollWidth ?? cellWidth * cols,
        contentHeight: term.element?.scrollHeight ?? rect.height,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        totalScale: nextFitScale * userScaleRef.current,
      });
      if (
        Math.abs(panOffsetRef.current.x - clamped.panX) > 0.5 ||
        Math.abs(panOffsetRef.current.y - clamped.panY) > 0.5
      ) {
        setPanOffset({ x: clamped.panX, y: clamped.panY });
      }
    },
    [viewportRef, termRef, viewportModeRef],
  );

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    const scheduleSync = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        if (viewportModeRef.current === "mobile") onSyncMobileViewport();
        else recomputeDesktopTransform();
      }, 90);
    };
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(container);
    window.visualViewport?.addEventListener("resize", scheduleSync);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", scheduleSync);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [viewportRef, viewportModeRef, onSyncMobileViewport, recomputeDesktopTransform]);

  useEffect(
    () => () => {
      if (touchGestureRafRef.current) cancelAnimationFrame(touchGestureRafRef.current);
    },
    [],
  );

  const scheduleTouchTransform = (next: { scale?: number; panX: number; panY: number }) => {
    pendingTouchStateRef.current = next;
    if (touchGestureRafRef.current) return;
    touchGestureRafRef.current = requestAnimationFrame(() => {
      touchGestureRafRef.current = 0;
      const pending = pendingTouchStateRef.current;
      if (!pending) return;
      pendingTouchStateRef.current = null;
      if (pending.scale !== undefined) setUserScale(pending.scale);
      setPanOffset({ x: pending.panX, y: pending.panY });
    });
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2 && viewportMode === "desktop") {
      const [first, second] = [event.touches[0], event.touches[1]];
      gestureRef.current = {
        mode: "pinch",
        startX: (first.clientX + second.clientX) / 2,
        startY: (first.clientY + second.clientY) / 2,
        startPanX: panOffsetRef.current.x,
        startPanY: panOffsetRef.current.y,
        startDistance: Math.max(
          1,
          Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        ),
        startUserScale: userScaleRef.current,
        moved: true,
      };
      return;
    }
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      scrollAccRef.current = 0;
      gestureRef.current = {
        mode: "pan",
        startX: touch.clientX,
        startY: touch.clientY,
        startPanX: panOffsetRef.current.x,
        startPanY: panOffsetRef.current.y,
        startDistance: 0,
        startUserScale: userScaleRef.current,
        moved: false,
      };
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const container = viewportRef.current;
    const term = termRef.current;
    if (!container || !term) return;

    if (
      gestureRef.current.mode === "pinch" &&
      event.touches.length === 2 &&
      viewportMode === "desktop"
    ) {
      const [first, second] = [event.touches[0], event.touches[1]];
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      const nextUserScale = Math.min(
        3,
        Math.max(
          1,
          gestureRef.current.startUserScale * (distance / gestureRef.current.startDistance),
        ),
      );
      const rect = container.getBoundingClientRect();
      const { cellWidth } = readXtermCellMetrics(term);
      const clamped = clampDesktopPan({
        panX: panOffsetRef.current.x,
        panY: panOffsetRef.current.y,
        contentWidth: term.element?.scrollWidth ?? cellWidth * term.cols,
        contentHeight: term.element?.scrollHeight ?? rect.height,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        totalScale: fitScaleRef.current * nextUserScale,
      });
      scheduleTouchTransform({ scale: nextUserScale, panX: clamped.panX, panY: clamped.panY });
      return;
    }

    if (gestureRef.current.mode === "pan" && event.touches.length === 1) {
      const touch = event.touches[0];
      const deltaX = touch.clientX - gestureRef.current.startX;
      const deltaY = touch.clientY - gestureRef.current.startY;
      if (Math.hypot(deltaX, deltaY) > 6) gestureRef.current.moved = true;

      if (viewportMode === "desktop" && userScaleRef.current > 1.02) {
        const rect = container.getBoundingClientRect();
        const { cellWidth } = readXtermCellMetrics(term);
        const clamped = clampDesktopPan({
          panX: gestureRef.current.startPanX + deltaX,
          panY: gestureRef.current.startPanY + deltaY,
          contentWidth: term.element?.scrollWidth ?? cellWidth * term.cols,
          contentHeight: term.element?.scrollHeight ?? rect.height,
          viewportWidth: rect.width,
          viewportHeight: rect.height,
          totalScale: fitScaleRef.current * userScaleRef.current,
        });
        scheduleTouchTransform({ panX: clamped.panX, panY: clamped.panY });
        return;
      }

      const stepPx = 16;
      const stepDelta = touch.clientY - (gestureRef.current.startY + scrollAccRef.current);
      const lines = Math.trunc(-stepDelta / stepPx);
      if (lines !== 0) {
        scrollAccRef.current += -lines * stepPx;
        if (modesRef.current.altScreen || modesRef.current.mouseTrackingMode !== "none") {
          void onSendScroll(lines);
        } else {
          term.scrollLines(lines);
        }
      }
    }
  };

  const handleTouchEnd = () => {
    if (!gestureRef.current.moved) termRef.current?.focus();
    gestureRef.current.mode = "none";
  };

  const resetDesktopZoom = useCallback(() => {
    setUserScale(1);
    setPanOffset({ x: 0, y: 0 });
    recomputeDesktopTransform();
  }, [recomputeDesktopTransform]);

  return {
    fitScale,
    userScale,
    panOffset,
    measureMobileGrid,
    recomputeDesktopTransform,
    resetDesktopZoom,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
