import { useCallback, useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown } from "lucide-react";
import type { TerminalReplayPayload } from "../../protocol/rpc";
import { useTerminalController } from "../../state/useTerminalController";
import { TerminalAccessoryBar } from "./TerminalAccessoryBar";
import { TerminalToolbar } from "./TerminalToolbar";
import { useXtermInstance } from "./useXtermInstance";

interface RawTerminalViewProps {
  surfaceId: string;
  surfaceTitle: string;
  tty?: string;
  isDesktop?: boolean;
}

export function RawTerminalView({
  surfaceId,
  surfaceTitle,
  tty,
  isDesktop = false,
}: RawTerminalViewProps) {
  const measureGridBridgeRef = useRef<() => { cols: number; rows: number } | null>(() => null);
  const applyReplayBridgeRef = useRef<(payload: TerminalReplayPayload | undefined) => void>(
    () => {},
  );
  const resetFpBridgeRef = useRef<() => void>(() => {});
  const getAppCursorBridgeRef = useRef<() => boolean>(() => false);

  const measureMobileGridBridge = useCallback(() => measureGridBridgeRef.current(), []);
  const handleReplayPayloadBridge = useCallback(
    (payload: TerminalReplayPayload | undefined) => applyReplayBridgeRef.current(payload),
    [],
  );
  const handleResetFingerprintBridge = useCallback(() => resetFpBridgeRef.current(), []);
  const getApplicationCursorKeysModeBridge = useCallback(() => getAppCursorBridgeRef.current(), []);

  const controller = useTerminalController({
    surfaceId,
    isDesktop,
    measureMobileGrid: measureMobileGridBridge,
    onReplayPayload: handleReplayPayloadBridge,
    onResetFingerprint: handleResetFingerprintBridge,
    getApplicationCursorKeysMode: getApplicationCursorKeysModeBridge,
  });

  const {
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
  } = useXtermInstance({
    surfaceId,
    viewportMode: controller.viewportMode,
    viewportModeRef: controller.viewportModeRef,
    ctrlLatchRef: controller.ctrlLatchRef,
    altLatchRef: controller.altLatchRef,
    consumeLatches: controller.consumeLatches,
    onSendBytes: controller.sendTerminalBytes,
    onSendPaste: controller.sendTerminalPaste,
    onSendScroll: controller.sendTerminalScroll,
    onSyncMobileViewport: () => void controller.syncViewportToGateway("mobile"),
  });

  useEffect(() => {
    measureGridBridgeRef.current = measureMobileGrid;
    applyReplayBridgeRef.current = applyReplayPayload;
    resetFpBridgeRef.current = resetLastAppliedKey;
    getAppCursorBridgeRef.current = getApplicationCursorKeysMode;
  }, [measureMobileGrid, applyReplayPayload, resetLastAppliedKey, getApplicationCursorKeysMode]);

  const handleToggleMode = async () => {
    resetDesktopZoom();
    await controller.handleToggleViewportMode();
    recomputeDesktopTransform();
  };

  const handlePasteClipboard = async () => {
    try {
      let text = "";
      if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
      if (!text) {
        const prompted = window.prompt("Paste text into terminal:");
        if (prompted !== null) text = prompted;
      }
      if (text) await controller.sendTerminalPaste(text);
    } catch {
      const prompted = window.prompt("Paste text into terminal:");
      if (prompted) await controller.sendTerminalPaste(prompted);
    }
  };

  const totalScale = controller.viewportMode === "desktop" ? fitScale * userScale : 1;

  const statusToolbar = (
    <TerminalToolbar
      connState={controller.connState}
      subscribed={controller.subscribed}
      gridDims={gridDims}
      tty={tty}
      viewportMode={controller.viewportMode}
      userScale={userScale}
      showKeyBar={controller.showKeyBar}
      isRefreshing={controller.isRefreshing}
      bottomBar={isDesktop}
      onResetZoom={resetDesktopZoom}
      onToggleKeyBar={() => controller.setShowKeyBar((v) => !v)}
      onToggleViewportMode={() => void handleToggleMode()}
      onRefresh={() => void controller.handleManualRefresh()}
    />
  );

  return (
    <div
      className="flex flex-col h-full bg-bg text-fg font-mono select-none overflow-hidden"
      aria-label={surfaceTitle}
    >
      {!isDesktop && statusToolbar}

      <div
        ref={viewportRef}
        onClick={focusTerminal}
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
            controller.viewportMode === "desktop"
              ? {
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${totalScale})`,
                  transformOrigin: "top left",
                }
              : undefined
          }
          className={
            controller.viewportMode === "mobile"
              ? "w-full h-full cmux-xterm-host"
              : "inline-block min-w-full min-h-full cmux-xterm-host"
          }
        />

        {controller.pasteNotice && (
          <div className="absolute top-2 right-3 px-2 py-0.5 rounded bg-surface border border-line-strong text-fg text-[11px] font-sans font-medium shadow">
            {controller.pasteNotice}
          </div>
        )}

        {showScrollBottomPill && (
          <button
            type="button"
            onTouchStart={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              scrollToBottom();
            }}
            className="absolute bottom-3 right-3 h-8 px-3 flex items-center gap-1 rounded-full bg-surface hover:bg-raised text-fg text-[12px] font-medium shadow-lg border border-line-strong transition-all z-10 font-sans"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            <span>Bottom</span>
          </button>
        )}
      </div>

      {controller.showKeyBar && (
        <TerminalAccessoryBar
          ctrlLatch={controller.ctrlLatch}
          altLatch={controller.altLatch}
          activeKey={controller.activeKey}
          onPasteClipboard={() => void handlePasteClipboard()}
          onCtrlTap={controller.handleCtrlTap}
          onAltTap={controller.handleAltTap}
          onKeyPress={(item) => {
            enableAutoScroll();
            void controller.handleKeyPress(item);
          }}
          onDismissKeyboard={dismissKeyboard}
        />
      )}

      {isDesktop && statusToolbar}
    </div>
  );
}
