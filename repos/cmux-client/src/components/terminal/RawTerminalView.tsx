import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  RefreshCw,
  ChevronDown,
  Monitor,
  Smartphone,
  ClipboardPaste,
  Keyboard,
  KeyboardOff,
} from "lucide-react";
import {
  RPC_EVENTS,
  RPC_METHODS,
  type RenderGridData,
  type TerminalReplayPayload,
} from "../../protocol/rpc";
import { wsClient, type ConnectionState } from "../../transport/wsClient";
import { convertRenderGridToAnsi, type TerminalGridModes } from "./renderGridToAnsi";
import {
  applyStickyModifiersToText,
  clampDesktopPan,
  computeDesktopFitScale,
  computeMobileGridDimensions,
  consumeStickyLatch,
  encodeAccessoryKey,
  getOrCreateTerminalClientId,
  transitionStickyLatch,
  type StickyModifierLatch,
  type TerminalViewportMode,
} from "./terminalViewport";

interface RawTerminalViewProps {
  surfaceId: string;
  surfaceTitle: string;
  tty?: string;
  isDesktop?: boolean;
}

interface TerminalKeyItem {
  id: string;
  label: string;
  key?: string;
  text?: string;
  icon?: typeof ArrowUp;
  category?: "nav" | "symbol" | "signal";
}

const EXTENDED_KEYS: TerminalKeyItem[] = [
  { id: "esc", label: "Esc", key: "escape" },
  { id: "tab", label: "Tab", key: "tab" },
  { id: "shiftTab", label: "⇧Tab", key: "shift+tab" },
  { id: "enter", label: "Enter", key: "enter", icon: CornerDownLeft },
  { id: "up", label: "↑", key: "up", icon: ArrowUp, category: "nav" },
  { id: "down", label: "↓", key: "down", icon: ArrowDown, category: "nav" },
  { id: "left", label: "←", key: "left", icon: ArrowLeft, category: "nav" },
  { id: "right", label: "→", key: "right", icon: ArrowRight, category: "nav" },
  { id: "pipe", label: "|", text: "|", category: "symbol" },
  { id: "slash", label: "/", text: "/", category: "symbol" },
  { id: "tilde", label: "~", text: "~", category: "symbol" },
  { id: "backtick", label: "`", text: "`", category: "symbol" },
  { id: "dash", label: "-", text: "-", category: "symbol" },
  { id: "underscore", label: "_", text: "_", category: "symbol" },
  { id: "ctrlC", label: "^C", key: "ctrl+c", category: "signal" },
  { id: "ctrlD", label: "^D", key: "ctrl+d", category: "signal" },
  { id: "ctrlZ", label: "^Z", key: "ctrl+z", category: "signal" },
  { id: "ctrlL", label: "^L", key: "ctrl+l", category: "signal" },
  { id: "ctrlR", label: "^R", key: "ctrl+r", category: "signal" },
];

const FIXED_FONT_SIZE = 12;
/** `.cmux-xterm-host .xterm { padding: 6px }` (index.css). The grid must fit inside it, otherwise
 *  the last column(s) are clipped on the right. */
const XTERM_PADDING_PX = 6;
const DEFAULT_CELL_WIDTH = 7.2;
const DEFAULT_CELL_HEIGHT = 15.6;
const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

interface XtermInternalDimensions {
  css?: {
    cell?: {
      width?: number;
      height?: number;
    };
  };
}

interface XtermWithCore {
  _core?: {
    _renderService?: {
      dimensions?: XtermInternalDimensions;
    };
  };
}

function readXtermCellMetrics(term: XtermTerminal | null): {
  cellWidth: number;
  cellHeight: number;
} {
  if (!term) {
    return { cellWidth: DEFAULT_CELL_WIDTH, cellHeight: DEFAULT_CELL_HEIGHT };
  }
  const coreTerm = term as unknown as XtermWithCore;
  const cell = coreTerm._core?._renderService?.dimensions?.css?.cell;
  const width = cell?.width && cell.width > 0 ? cell.width : DEFAULT_CELL_WIDTH;
  const height = cell?.height && cell.height > 0 ? cell.height : DEFAULT_CELL_HEIGHT;
  return { cellWidth: width, cellHeight: height };
}

function viewportStorageKey(isDesktop: boolean): string {
  return isDesktop ? "cmux_terminal_viewport_mode_desktop" : "cmux_terminal_viewport_mode";
}

function loadSavedViewportMode(isDesktop: boolean): TerminalViewportMode {
  try {
    const saved = localStorage.getItem(viewportStorageKey(isDesktop));
    if (saved === "desktop" || saved === "mobile") {
      return saved;
    }
  } catch {
    return "mobile";
  }
  return "mobile";
}

export function RawTerminalView({
  surfaceId,
  surfaceTitle,
  tty,
  isDesktop = false,
}: RawTerminalViewProps) {
  const [viewportMode, setViewportMode] = useState<TerminalViewportMode>(() =>
    loadSavedViewportMode(isDesktop),
  );
  const [showKeyBar, setShowKeyBar] = useState<boolean>(() => !isDesktop);
  const [gridDims, setGridDims] = useState<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const [connState, setConnState] = useState<ConnectionState>(wsClient.getState());
  const [subscribed, setSubscribed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [ctrlLatch, setCtrlLatch] = useState<StickyModifierLatch>("off");
  const [altLatch, setAltLatch] = useState<StickyModifierLatch>("off");
  const [showScrollBottomPill, setShowScrollBottomPill] = useState(false);
  const [fitScale, setFitScale] = useState(1);
  const [userScale, setUserScale] = useState(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const clientIdRef = useRef<string>(getOrCreateTerminalClientId());
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
  const viewportModeRef = useRef<TerminalViewportMode>(viewportMode);
  const ctrlLatchRef = useRef<StickyModifierLatch>(ctrlLatch);
  const altLatchRef = useRef<StickyModifierLatch>(altLatch);
  const lastCtrlTapRef = useRef(0);
  const lastAltTapRef = useRef(0);
  const shouldAutoScrollRef = useRef(true);
  const lastAppliedKeyRef = useRef<string>("");
  const lastSentViewportRef = useRef<string>("");
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAccRef = useRef(0);
  const userScaleRef = useRef(1);
  const fitScaleRef = useRef(1);
  const panOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const gestureRef = useRef<{
    mode: "none" | "pan" | "pinch";
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    startDistance: number;
    startUserScale: number;
    moved: boolean;
  }>({
    mode: "none",
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    startDistance: 0,
    startUserScale: 1,
    moved: false,
  });

  useEffect(() => {
    setShowKeyBar(!isDesktop);
    const saved = loadSavedViewportMode(isDesktop);
    viewportModeRef.current = saved;
    setViewportMode(saved);
  }, [isDesktop]);

  useEffect(() => {
    viewportModeRef.current = viewportMode;
    try {
      localStorage.setItem(viewportStorageKey(isDesktop), viewportMode);
    } catch {
      return;
    }
  }, [viewportMode, isDesktop]);

  useEffect(() => {
    ctrlLatchRef.current = ctrlLatch;
  }, [ctrlLatch]);

  useEffect(() => {
    altLatchRef.current = altLatch;
  }, [altLatch]);

  useEffect(() => {
    userScaleRef.current = userScale;
  }, [userScale]);

  useEffect(() => {
    fitScaleRef.current = fitScale;
  }, [fitScale]);

  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);

  useEffect(() => {
    return wsClient.onStateChange((state) => {
      setConnState(state);
    });
  }, []);

  const recomputeDesktopTransform = useCallback((colsOverride?: number) => {
    const container = viewportRef.current;
    const term = termRef.current;
    if (!container || !term) return;

    if (viewportModeRef.current === "mobile") {
      setFitScale(1);
      setUserScale(1);
      setPanOffset({ x: 0, y: 0 });
      return;
    }

    const rect = container.getBoundingClientRect();
    const { cellWidth } = readXtermCellMetrics(term);
    const cols = colsOverride ?? term.cols;
    // Measure the grid as rendered; cellWidth*cols relies on xterm internals and can be off.
    const screenWidth = term.element?.querySelector<HTMLElement>(".xterm-screen")?.offsetWidth ?? 0;
    const scrollWidth = term.element?.scrollWidth ?? 0;
    const nextFitScale = computeDesktopFitScale({
      viewportWidth: rect.width,
      cols,
      cellWidth: screenWidth > 0 ? 0 : cellWidth,
      scrollWidth: screenWidth > 0 ? screenWidth + XTERM_PADDING_PX * 2 : scrollWidth,
    });
    setFitScale(nextFitScale);

    const nextTotalScale = nextFitScale * userScaleRef.current;
    const contentWidth = term.element?.scrollWidth ?? cellWidth * cols;
    const contentHeight = term.element?.scrollHeight ?? rect.height;
    const clamped = clampDesktopPan({
      panX: panOffsetRef.current.x,
      panY: panOffsetRef.current.y,
      contentWidth,
      contentHeight,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      totalScale: nextTotalScale,
    });
    setPanOffset({ x: clamped.panX, y: clamped.panY });
  }, []);

  const sendTerminalBytes = useCallback(
    async (bytes: string) => {
      if (!surfaceId || !bytes) return;
      try {
        await wsClient.call(RPC_METHODS.TERMINAL_INPUT, {
          surface_id: surfaceId,
          text: bytes,
          kind: "text",
        });
      } catch (err) {
        console.warn("Failed to send terminal input:", err);
      }
    },
    [surfaceId],
  );

  const sendTerminalScroll = useCallback(
    async (deltaLines: number) => {
      if (!surfaceId || deltaLines === 0) return;
      try {
        await wsClient.call(RPC_METHODS.TERMINAL_SCROLL, {
          surface_id: surfaceId,
          // Client convention: +N = toward newer output (like xterm `scrollLines`, wheel deltaY > 0).
          // cmux `mobile.terminal.scroll` is the opposite: verified live with `less` on a 300-line
          // file, delta_lines=-3 moved the top line 1 -> 10 and +3 moved it back to 1.
          delta_lines: -deltaLines,
          col: 0,
          row: 0,
        });
      } catch (err) {
        console.warn("Failed to scroll terminal:", err);
      }
    },
    [surfaceId],
  );

  const applyReplayPayload = useCallback(
    (payload: TerminalReplayPayload | undefined) => {
      if (!payload) return;
      if (payload.surface_id && payload.surface_id !== surfaceId) return;
      const term = termRef.current;
      if (!term || !payload.render_grid) return;

      const grid: RenderGridData = payload.render_grid;
      const frameKey = `${grid.columns}x${grid.rows}:${grid.render_epoch ?? ""}:${grid.state_seq ?? ""}:${grid.render_revision ?? ""}:${grid.active_screen}`;
      if (frameKey === lastAppliedKeyRef.current) {
        return;
      }
      lastAppliedKeyRef.current = frameKey;

      const converted = convertRenderGridToAnsi(grid);
      modesRef.current = converted.modes;
      term.options.theme = converted.theme;

      if (term.cols !== converted.columns || term.rows !== converted.rows) {
        term.resize(converted.columns, converted.rows);
      }
      setGridDims({ cols: converted.columns, rows: converted.rows });

      const activeBuffer = term.buffer.active;
      const wasAtBottom = activeBuffer.viewportY >= activeBuffer.baseY;
      const savedViewportY = activeBuffer.viewportY;

      term.write(converted.ansiPayload, () => {
        if (converted.modes.altScreen) {
          shouldAutoScrollRef.current = true;
          setShowScrollBottomPill(false);
        } else if (shouldAutoScrollRef.current || wasAtBottom) {
          term.scrollToBottom();
          setShowScrollBottomPill(false);
        } else {
          term.scrollToLine(savedViewportY);
          setShowScrollBottomPill(true);
        }
        recomputeDesktopTransform(converted.columns);
      });
    },
    [surfaceId, recomputeDesktopTransform],
  );

  const syncViewportToGateway = useCallback(
    async (targetMode: TerminalViewportMode, force = false) => {
      if (!surfaceId || wsClient.getState() !== "connected") return;
      if (targetMode === "desktop") {
        if (!force && lastSentViewportRef.current === "desktop") return;
        lastSentViewportRef.current = "desktop";
        try {
          await wsClient.call(RPC_METHODS.TERMINAL_VIEWPORT, {
            surface_id: surfaceId,
            client_id: clientIdRef.current,
            mode: "desktop",
            clear: true,
          });
        } catch (err) {
          console.warn("Failed to set desktop viewport:", err);
        }
        return;
      }

      const container = viewportRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const { cellWidth, cellHeight } = readXtermCellMetrics(termRef.current);
      const dims = computeMobileGridDimensions({
        viewportWidth: rect.width - XTERM_PADDING_PX * 2,
        viewportHeight: rect.height - XTERM_PADDING_PX * 2,
        cellWidth,
        cellHeight,
      });
      const sig = `mobile:${dims.cols}x${dims.rows}`;
      if (!force && lastSentViewportRef.current === sig) return;
      lastSentViewportRef.current = sig;

      try {
        await wsClient.call(RPC_METHODS.TERMINAL_VIEWPORT, {
          surface_id: surfaceId,
          client_id: clientIdRef.current,
          mode: "mobile",
          columns: dims.cols,
          rows: dims.rows,
        });
      } catch (err) {
        console.warn("Failed to set mobile viewport:", err);
      }
    },
    [surfaceId],
  );

  const fetchReplay = useCallback(async () => {
    if (!surfaceId || wsClient.getState() !== "connected") return;
    try {
      const container = viewportRef.current;
      let params: Record<string, unknown> = {
        surface_id: surfaceId,
        max_scrollback_rows: 500,
      };
      if (viewportModeRef.current === "mobile" && container) {
        const rect = container.getBoundingClientRect();
        const { cellWidth, cellHeight } = readXtermCellMetrics(termRef.current);
        const dims = computeMobileGridDimensions({
          viewportWidth: rect.width - XTERM_PADDING_PX * 2,
          viewportHeight: rect.height - XTERM_PADDING_PX * 2,
          cellWidth,
          cellHeight,
        });
        params = {
          ...params,
          columns: dims.cols,
          rows: dims.rows,
        };
      }
      const res = await wsClient.call<TerminalReplayPayload>(RPC_METHODS.TERMINAL_REPLAY, params);
      applyReplayPayload(res);
    } catch (err) {
      console.warn("Failed to replay terminal:", err);
    }
  }, [surfaceId, applyReplayPayload]);

  useEffect(() => {
    const host = surfaceHostRef.current;
    if (!host) return;

    lastAppliedKeyRef.current = "";
    lastSentViewportRef.current = "";
    shouldAutoScrollRef.current = true;
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
      theme: {
        background: "#0a0a0a",
        foreground: "#fafafa",
        cursor: "#fcfcfa",
      },
    });

    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";

    term.open(host);

    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch {
      webglAddon = null;
    }

    const dataDisposable = term.onData((rawData) => {
      const bytes = applyStickyModifiersToText(rawData, ctrlLatchRef.current, altLatchRef.current);
      setCtrlLatch((prev) => consumeStickyLatch(prev));
      setAltLatch((prev) => consumeStickyLatch(prev));
      shouldAutoScrollRef.current = true;
      void sendTerminalBytes(bytes);
    });

    const scrollDisposable = term.onScroll(() => {
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
        const step = wheelEvent.deltaY > 0 ? 3 : -3;
        void sendTerminalScroll(step);
        return false;
      }
      return true;
    });

    termRef.current = term;
    requestAnimationFrame(() => {
      recomputeDesktopTransform();
    });

    return () => {
      dataDisposable.dispose();
      scrollDisposable.dispose();
      webglAddon?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [surfaceId, sendTerminalBytes, sendTerminalScroll, recomputeDesktopTransform]);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;

    const scheduleSync = () => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        if (viewportModeRef.current === "mobile") {
          void syncViewportToGateway("mobile");
        } else {
          recomputeDesktopTransform();
        }
      }, 90);
    };

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(container);

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", scheduleSync);

    return () => {
      observer.disconnect();
      visualViewport?.removeEventListener("resize", scheduleSync);
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
    };
  }, [syncViewportToGateway, recomputeDesktopTransform]);

  useEffect(() => {
    if (connState !== "connected" || !surfaceId) {
      setSubscribed(false);
      return;
    }

    const controller = new AbortController();
    const offEvent = wsClient.onEvent((eventName, data) => {
      if (eventName !== RPC_EVENTS.TERMINAL_UPDATE) return;
      applyReplayPayload(data as TerminalReplayPayload);
    });

    const container = viewportRef.current;
    const rect = container?.getBoundingClientRect();
    const { cellWidth, cellHeight } = readXtermCellMetrics(termRef.current);
    const mobileDims =
      rect && rect.width > 0 && rect.height > 0
        ? computeMobileGridDimensions({
            viewportWidth: rect.width - XTERM_PADDING_PX * 2,
            viewportHeight: rect.height - XTERM_PADDING_PX * 2,
            cellWidth,
            cellHeight,
          })
        : { cols: 45, rows: 24 };

    wsClient
      .call(RPC_METHODS.TERMINAL_SUBSCRIBE, {
        surface_id: surfaceId,
        client_id: clientIdRef.current,
        mode: viewportModeRef.current,
        columns: viewportModeRef.current === "mobile" ? mobileDims.cols : undefined,
        rows: viewportModeRef.current === "mobile" ? mobileDims.rows : undefined,
        max_scrollback_rows: 500,
      })
      .then(() => {
        if (!controller.signal.aborted) {
          setSubscribed(true);
          void fetchReplay();
        }
      })
      .catch((err) => {
        console.warn("Terminal subscribe failed, using fallback replay:", err);
        void fetchReplay();
      });

    return () => {
      controller.abort();
      offEvent();
      setSubscribed(false);
      void wsClient
        .call(RPC_METHODS.TERMINAL_UNSUBSCRIBE, { surface_id: surfaceId })
        .catch(() => {});
    };
  }, [connState, surfaceId, applyReplayPayload, fetchReplay]);

  useEffect(() => {
    if (subscribed) return;
    void fetchReplay();
    const interval = setInterval(() => {
      void fetchReplay();
    }, 800);
    return () => clearInterval(interval);
  }, [subscribed, fetchReplay]);

  const handleToggleViewportMode = async () => {
    const nextMode: TerminalViewportMode = viewportMode === "mobile" ? "desktop" : "mobile";
    viewportModeRef.current = nextMode;
    setViewportMode(nextMode);
    setUserScale(1);
    setPanOffset({ x: 0, y: 0 });
    lastAppliedKeyRef.current = "";
    lastSentViewportRef.current = "";
    await syncViewportToGateway(nextMode, true);
    recomputeDesktopTransform();
    setTimeout(() => {
      void fetchReplay();
    }, 140);
  };

  const handleResetDesktopZoom = () => {
    setUserScale(1);
    setPanOffset({ x: 0, y: 0 });
    recomputeDesktopTransform();
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    lastAppliedKeyRef.current = "";
    await fetchReplay();
    setTimeout(() => setIsRefreshing(false), 250);
  };

  const handleCtrlTap = () => {
    const now = Date.now();
    const isDoubleTap = now - lastCtrlTapRef.current < 320;
    lastCtrlTapRef.current = now;
    setCtrlLatch((prev) => transitionStickyLatch(prev, isDoubleTap));
  };

  const handleAltTap = () => {
    const now = Date.now();
    const isDoubleTap = now - lastAltTapRef.current < 320;
    lastAltTapRef.current = now;
    setAltLatch((prev) => transitionStickyLatch(prev, isDoubleTap));
  };

  const handleKeyPress = async (item: TerminalKeyItem) => {
    setActiveKey(item.id);
    setTimeout(() => setActiveKey(null), 140);
    shouldAutoScrollRef.current = true;

    let bytes = "";
    if (item.key) {
      bytes = encodeAccessoryKey(item.key, modesRef.current.applicationCursorKeysMode);
      if (altLatchRef.current !== "off" && bytes.length > 0 && !bytes.startsWith("\x1b")) {
        bytes = `\x1b${bytes}`;
      }
    } else if (item.text) {
      bytes = applyStickyModifiersToText(item.text, ctrlLatchRef.current, altLatchRef.current);
    }

    setCtrlLatch((prev) => consumeStickyLatch(prev));
    setAltLatch((prev) => consumeStickyLatch(prev));
    if (bytes) {
      await sendTerminalBytes(bytes);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      let text = "";
      if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
      if (!text) {
        const prompted = window.prompt("Paste text into terminal:");
        if (prompted !== null) {
          text = prompted;
        }
      }
      if (!text) return;
      await wsClient.call(RPC_METHODS.TERMINAL_PASTE, {
        surface_id: surfaceId,
        text,
      });
      setPasteNotice("Pasted");
      setTimeout(() => setPasteNotice(null), 1200);
    } catch {
      const prompted = window.prompt("Paste text into terminal:");
      if (prompted) {
        await wsClient.call(RPC_METHODS.TERMINAL_PASTE, {
          surface_id: surfaceId,
          text: prompted,
        });
      }
    }
  };

  const handleDismissKeyboard = () => {
    termRef.current?.blur();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleScrollToBottom = () => {
    shouldAutoScrollRef.current = true;
    termRef.current?.scrollToBottom();
    setShowScrollBottomPill(false);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2 && viewportMode === "desktop") {
      const first = event.touches[0];
      const second = event.touches[1];
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      gestureRef.current = {
        mode: "pinch",
        startX: (first.clientX + second.clientX) / 2,
        startY: (first.clientY + second.clientY) / 2,
        startPanX: panOffsetRef.current.x,
        startPanY: panOffsetRef.current.y,
        startDistance: Math.max(1, distance),
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
      const first = event.touches[0];
      const second = event.touches[1];
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      const nextUserScale = Math.min(
        3,
        Math.max(
          1,
          gestureRef.current.startUserScale * (distance / gestureRef.current.startDistance),
        ),
      );
      setUserScale(nextUserScale);

      const rect = container.getBoundingClientRect();
      const { cellWidth } = readXtermCellMetrics(term);
      const totalScale = fitScaleRef.current * nextUserScale;
      const contentWidth = term.element?.scrollWidth ?? cellWidth * term.cols;
      const contentHeight = term.element?.scrollHeight ?? rect.height;
      const clamped = clampDesktopPan({
        panX: panOffsetRef.current.x,
        panY: panOffsetRef.current.y,
        contentWidth,
        contentHeight,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        totalScale,
      });
      setPanOffset({ x: clamped.panX, y: clamped.panY });
      return;
    }

    if (gestureRef.current.mode === "pan" && event.touches.length === 1) {
      const touch = event.touches[0];
      const deltaX = touch.clientX - gestureRef.current.startX;
      const deltaY = touch.clientY - gestureRef.current.startY;
      if (Math.hypot(deltaX, deltaY) > 6) {
        gestureRef.current.moved = true;
      }

      if (viewportMode === "desktop" && userScaleRef.current > 1.02) {
        const rect = container.getBoundingClientRect();
        const { cellWidth } = readXtermCellMetrics(term);
        const totalScale = fitScaleRef.current * userScaleRef.current;
        const contentWidth = term.element?.scrollWidth ?? cellWidth * term.cols;
        const contentHeight = term.element?.scrollHeight ?? rect.height;
        const clamped = clampDesktopPan({
          panX: gestureRef.current.startPanX + deltaX,
          panY: gestureRef.current.startPanY + deltaY,
          contentWidth,
          contentHeight,
          viewportWidth: rect.width,
          viewportHeight: rect.height,
          totalScale,
        });
        setPanOffset({ x: clamped.panX, y: clamped.panY });
        return;
      }

      const stepPx = 16;
      const stepDelta = touch.clientY - (gestureRef.current.startY + scrollAccRef.current);
      const lines = Math.trunc(-stepDelta / stepPx);
      if (lines !== 0) {
        scrollAccRef.current += -lines * stepPx;
        if (modesRef.current.altScreen || modesRef.current.mouseTrackingMode !== "none") {
          void sendTerminalScroll(lines);
        } else {
          term.scrollLines(lines);
        }
      }
    }
  };

  const handleTouchEnd = () => {
    if (!gestureRef.current.moved) {
      termRef.current?.focus();
    }
    gestureRef.current.mode = "none";
  };

  const totalScale = viewportMode === "desktop" ? fitScale * userScale : 1;

  return (
    <div
      className="flex flex-col h-full bg-bg text-fg font-mono select-none overflow-hidden"
      aria-label={surfaceTitle}
    >
      <div className="flex items-center justify-between px-3 min-h-[40px] bg-bg border-b border-white/[0.07] text-muted shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-sans font-medium px-2 py-0.5 rounded-md ${
              connState === "connected"
                ? "text-emerald-400 bg-emerald-500/10"
                : "text-amber-300 bg-amber-500/10"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                connState === "connected" ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            <span>{subscribed ? "Live" : "Sync"}</span>
          </span>

          <span
            className="text-[11px] text-dim font-mono shrink-0"
            title="Terminal size (columns × rows)"
          >
            {gridDims.cols}×{gridDims.rows}
          </span>

          {tty && (
            <span className="text-dim font-mono text-[12px] truncate hidden sm:inline">{tty}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 font-sans">
          {viewportMode === "desktop" && userScale > 1.02 && (
            <button
              type="button"
              onClick={handleResetDesktopZoom}
              className="h-8 px-2.5 rounded-lg bg-raised border border-white/[0.12] text-[12px] font-semibold text-accent-soft hover:text-white"
              title="Reset zoom"
            >
              1×
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowKeyBar((v) => !v)}
            className={`w-8 h-8 rounded-lg border transition-colors flex items-center justify-center ${
              showKeyBar
                ? "bg-raised border-white/[0.14] text-fg"
                : "bg-bg border-white/[0.08] text-muted hover:text-fg hover:bg-raised"
            }`}
            title={showKeyBar ? "Hide key bar" : "Show key bar"}
            aria-label={showKeyBar ? "Hide key bar" : "Show key bar"}
            aria-pressed={showKeyBar}
          >
            <Keyboard className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              void handleToggleViewportMode();
            }}
            aria-label={
              viewportMode === "mobile" ? "Switch to mirror Mac size" : "Switch to fit pane size"
            }
            className={`flex items-center justify-center w-9 h-8 rounded-lg border transition-colors ${
              viewportMode === "desktop"
                ? "bg-accent border-accent text-white"
                : "bg-raised border-white/[0.08] text-fg hover:bg-line"
            }`}
            title={
              viewportMode === "mobile"
                ? "Mirror Mac window size (full Mac cols×rows)"
                : "Fit terminal to this pane (crisp 1:1 cols×rows)"
            }
          >
            {viewportMode === "desktop" ? (
              <>
                <Monitor className="w-4 h-4" />
              </>
            ) : (
              <>
                <Smartphone className="w-4 h-4 text-[#86efac]" />
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              void handleManualRefresh();
            }}
            className="w-8 h-8 rounded-lg bg-raised hover:bg-line text-fg-soft flex items-center justify-center transition-colors"
            title="Refresh terminal"
            aria-label="Refresh terminal"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        onClick={() => termRef.current?.focus()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`flex-1 relative min-h-0 bg-bg overflow-hidden ${
          isDesktop ? "select-text" : "touch-none"
        }`}
      >
        <div
          ref={surfaceHostRef}
          style={
            viewportMode === "desktop"
              ? {
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${totalScale})`,
                  transformOrigin: "top left",
                }
              : undefined
          }
          className={
            viewportMode === "mobile"
              ? "w-full h-full cmux-xterm-host"
              : "inline-block min-w-full min-h-full cmux-xterm-host"
          }
        />

        {pasteNotice && (
          <div className="absolute top-2 right-3 px-2.5 py-1 rounded-md bg-emerald-600/90 text-white text-[11px] font-medium shadow">
            {pasteNotice}
          </div>
        )}

        {showScrollBottomPill && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleScrollToBottom();
            }}
            className="absolute bottom-3 right-3 h-9 px-3.5 flex items-center gap-1.5 rounded-full bg-raised/95 hover:bg-line text-fg text-[13px] font-medium shadow-lg backdrop-blur-sm border border-white/[0.14] transition-all z-10 font-sans"
          >
            <ChevronDown className="w-4 h-4" />
            <span>Bottom</span>
          </button>
        )}
      </div>

      {showKeyBar && (
        <div
          className="bg-bg border-t border-white/[0.08] px-2.5 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] shrink-0 flex items-center gap-2 overflow-x-auto no-scrollbar"
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              void handlePasteClipboard();
            }}
            className="h-9 px-3 rounded-[10px] bg-raised border border-white/[0.08] text-fg hover:bg-line active:opacity-70 text-[13px] font-sans font-medium shrink-0 flex items-center gap-1.5 transition-opacity"
            title="Paste from clipboard"
          >
            <ClipboardPaste className="w-4 h-4 text-muted" />
            <span>Paste</span>
          </button>

          <button
            type="button"
            onClick={handleCtrlTap}
            className={`h-9 min-w-[46px] px-3 rounded-[10px] border text-[13px] font-sans font-semibold shrink-0 transition-opacity active:opacity-70 ${
              ctrlLatch === "locked"
                ? "bg-fg border-fg text-bg"
                : ctrlLatch === "once"
                  ? "bg-raised border-fg text-fg"
                  : "bg-raised border-transparent text-fg hover:bg-line"
            }`}
            title="Sticky Ctrl (Tap: Once, Double Tap: Lock)"
          >
            {ctrlLatch === "locked" ? "CTRL" : "Ctrl"}
          </button>

          <button
            type="button"
            onClick={handleAltTap}
            className={`h-9 min-w-[42px] px-3 rounded-[10px] border text-[13px] font-sans font-semibold shrink-0 transition-opacity active:opacity-70 ${
              altLatch === "locked"
                ? "bg-fg border-fg text-bg"
                : altLatch === "once"
                  ? "bg-raised border-fg text-fg"
                  : "bg-raised border-transparent text-fg hover:bg-line"
            }`}
            title="Sticky Alt/Meta (Tap: Once, Double Tap: Lock)"
          >
            {altLatch === "locked" ? "ALT" : "Alt"}
          </button>

          {EXTENDED_KEYS.map((item) => {
            const Icon = item.icon;
            const isSignal = item.category === "signal";
            const isSymbol = item.category === "symbol";
            const isActive = activeKey === item.id;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  void handleKeyPress(item);
                }}
                className={`h-9 px-3 rounded-[10px] border text-[13px] font-medium transition-opacity shrink-0 flex items-center justify-center gap-1.5 active:opacity-70 ${
                  isActive
                    ? "bg-accent border-accent text-white"
                    : isSignal
                      ? "bg-[#28181b] border-rose-500/25 text-rose-300 hover:bg-[#341d22]"
                      : isSymbol
                        ? "bg-raised border-white/[0.06] text-fg min-w-[38px]"
                        : "bg-raised border-white/[0.06] text-fg min-w-[38px]"
                }`}
              >
                {Icon && <Icon className="w-4 h-4" />}
                {(!Icon || item.id === "enter") && <span>{item.label}</span>}
              </button>
            );
          })}

          <button
            type="button"
            onClick={handleDismissKeyboard}
            className="h-9 w-9 rounded-[10px] bg-raised border border-white/[0.06] text-muted hover:text-fg active:opacity-70 shrink-0 flex items-center justify-center transition-opacity"
            title="Hide keyboard"
            aria-label="Hide keyboard"
          >
            <KeyboardOff className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
