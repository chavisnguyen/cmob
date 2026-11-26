import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyStickyModifiersToText,
  consumeStickyLatch,
  encodeAccessoryKey,
  loadSavedViewportMode,
  transitionStickyLatch,
  viewportStorageKey,
  type StickyModifierLatch,
  type TerminalViewportMode,
} from "../domain/terminalState";
import { RPC_METHODS, type TerminalReplayPayload } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";
import { useTerminalSubscription } from "./useTerminalSubscription";

export const XTERM_PADDING_PX = 6;

export interface TerminalKeyActionItem {
  id: string;
  key?: string;
  text?: string;
}

export interface UseTerminalControllerOptions {
  surfaceId: string;
  isDesktop: boolean;
  measureMobileGrid: () => { cols: number; rows: number } | null;
  onReplayPayload: (payload: TerminalReplayPayload | undefined) => void;
  onResetFingerprint: () => void;
  getApplicationCursorKeysMode: () => boolean;
}

export function useTerminalController({
  surfaceId,
  isDesktop,
  measureMobileGrid,
  onReplayPayload,
  onResetFingerprint,
  getApplicationCursorKeysMode,
}: UseTerminalControllerOptions) {
  const [viewportMode, setViewportMode] = useState<TerminalViewportMode>(() =>
    loadSavedViewportMode(isDesktop),
  );
  const [showKeyBar, setShowKeyBar] = useState<boolean>(() => !isDesktop);
  const [connState, setConnState] = useState<ConnectionState>(() => wsClient.getState());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [ctrlLatch, setCtrlLatch] = useState<StickyModifierLatch>("off");
  const [altLatch, setAltLatch] = useState<StickyModifierLatch>("off");
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const viewportModeRef = useRef<TerminalViewportMode>(viewportMode);
  const ctrlLatchRef = useRef<StickyModifierLatch>(ctrlLatch);
  const altLatchRef = useRef<StickyModifierLatch>(altLatch);
  const lastCtrlTapRef = useRef(0);
  const lastAltTapRef = useRef(0);

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
      // Ignore storage errors
    }
  }, [viewportMode, isDesktop]);

  useEffect(() => {
    ctrlLatchRef.current = ctrlLatch;
  }, [ctrlLatch]);

  useEffect(() => {
    altLatchRef.current = altLatch;
  }, [altLatch]);

  useEffect(() => wsClient.onStateChange((state) => setConnState(state)), []);

  const getViewportMode = useCallback(() => viewportModeRef.current, []);

  const { subscribed, isMountedRef, syncViewportToGateway, fetchReplay } = useTerminalSubscription({
    connState,
    surfaceId,
    getViewportMode,
    measureMobileGrid,
    onReplayPayload,
  });

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

  const sendTerminalPaste = useCallback(
    async (text: string) => {
      if (!surfaceId || !text) return;
      await wsClient.call(RPC_METHODS.TERMINAL_PASTE, { surface_id: surfaceId, text });
      setPasteNotice("Pasted");
      setTimeout(() => setPasteNotice(null), 1200);
    },
    [surfaceId],
  );

  const sendTerminalScroll = useCallback(
    async (deltaLines: number) => {
      if (!surfaceId || deltaLines === 0) return;
      try {
        await wsClient.call(RPC_METHODS.TERMINAL_SCROLL, {
          surface_id: surfaceId,
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

  const handleToggleViewportMode = useCallback(async () => {
    const nextMode: TerminalViewportMode = viewportMode === "mobile" ? "desktop" : "mobile";
    viewportModeRef.current = nextMode;
    setViewportMode(nextMode);
    onResetFingerprint();
    await syncViewportToGateway(nextMode, true);
    if (!subscribed) void fetchReplay();
  }, [viewportMode, onResetFingerprint, syncViewportToGateway, subscribed, fetchReplay]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    onResetFingerprint();
    await fetchReplay();
    setTimeout(() => setIsRefreshing(false), 250);
  }, [onResetFingerprint, fetchReplay]);

  const handleCtrlTap = useCallback(() => {
    const now = Date.now();
    const isDoubleTap = now - lastCtrlTapRef.current < 320;
    lastCtrlTapRef.current = now;
    setCtrlLatch((prev) => transitionStickyLatch(prev, isDoubleTap));
  }, []);

  const handleAltTap = useCallback(() => {
    const now = Date.now();
    const isDoubleTap = now - lastAltTapRef.current < 320;
    lastAltTapRef.current = now;
    setAltLatch((prev) => transitionStickyLatch(prev, isDoubleTap));
  }, []);

  const consumeLatches = useCallback(() => {
    setCtrlLatch((prev) => consumeStickyLatch(prev));
    setAltLatch((prev) => consumeStickyLatch(prev));
  }, []);

  const handleKeyPress = useCallback(
    async (item: TerminalKeyActionItem) => {
      setActiveKey(item.id);
      setTimeout(() => setActiveKey(null), 140);
      let bytes = "";
      if (item.key) {
        bytes = encodeAccessoryKey(
          item.key,
          getApplicationCursorKeysMode(),
          ctrlLatchRef.current,
          altLatchRef.current,
        );
      } else if (item.text) {
        bytes = applyStickyModifiersToText(item.text, ctrlLatchRef.current, altLatchRef.current);
      }
      consumeLatches();
      if (bytes) await sendTerminalBytes(bytes);
    },
    [getApplicationCursorKeysMode, consumeLatches, sendTerminalBytes],
  );

  return {
    viewportMode,
    viewportModeRef,
    showKeyBar,
    setShowKeyBar,
    connState,
    subscribed,
    isRefreshing,
    activeKey,
    ctrlLatch,
    ctrlLatchRef,
    altLatch,
    altLatchRef,
    pasteNotice,
    isMountedRef,
    sendTerminalBytes,
    sendTerminalPaste,
    sendTerminalScroll,
    syncViewportToGateway,
    handleToggleViewportMode,
    handleManualRefresh,
    handleCtrlTap,
    handleAltTap,
    consumeLatches,
    handleKeyPress,
  };
}
