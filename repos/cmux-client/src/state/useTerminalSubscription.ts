import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeMobileGridDimensions,
  getOrCreateTerminalClientId,
  type TerminalViewportMode,
} from "../domain/terminalState";
import { RPC_EVENTS, RPC_METHODS, type TerminalReplayPayload } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";

export function useTerminalSubscription({
  connState,
  surfaceId,
  getViewportMode,
  measureMobileGrid,
  onReplayPayload,
}: {
  connState: ConnectionState;
  surfaceId: string;
  getViewportMode: () => TerminalViewportMode;
  measureMobileGrid: () => { cols: number; rows: number } | null;
  onReplayPayload: (payload: TerminalReplayPayload | undefined) => void;
}) {
  const [subscribed, setSubscribed] = useState(false);
  const [subscribeFailed, setSubscribeFailed] = useState(false);

  const clientIdRef = useRef<string>(getOrCreateTerminalClientId());
  const lastSentViewportRef = useRef("");
  const inFlightReplayRef = useRef(false);
  const isMountedRef = useRef(true);
  const mountedEndpointRef = useRef(wsClient.getEndpoint());

  const syncViewportToGateway = useCallback(
    async (targetMode: TerminalViewportMode, force = false) => {
      if (
        !isMountedRef.current ||
        !surfaceId ||
        wsClient.getState() !== "connected" ||
        wsClient.getEndpoint() !== mountedEndpointRef.current
      ) {
        return;
      }
      if (force) lastSentViewportRef.current = "";
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

      const dims = measureMobileGrid();
      if (!dims) return;
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
    [surfaceId, measureMobileGrid],
  );

  const fetchReplay = useCallback(async () => {
    if (!surfaceId || wsClient.getState() !== "connected" || inFlightReplayRef.current) return;
    inFlightReplayRef.current = true;
    try {
      let params: Record<string, unknown> = {
        surface_id: surfaceId,
        max_scrollback_rows: 500,
      };
      if (getViewportMode() === "mobile") {
        const dims = measureMobileGrid();
        if (dims) params = { ...params, columns: dims.cols, rows: dims.rows };
      }
      const res = await wsClient.call<TerminalReplayPayload>(RPC_METHODS.TERMINAL_REPLAY, params);
      if (isMountedRef.current) onReplayPayload(res);
    } catch (err) {
      console.warn("Failed to replay terminal:", err);
    } finally {
      inFlightReplayRef.current = false;
    }
  }, [surfaceId, getViewportMode, measureMobileGrid, onReplayPayload]);

  // Subscribe to live terminal updates and restore Mac viewport on unmount if in mobile mode.
  useEffect(() => {
    isMountedRef.current = true;
    const mountedEndpoint = wsClient.getEndpoint();
    mountedEndpointRef.current = mountedEndpoint;
    lastSentViewportRef.current = "";

    if (connState !== "connected" || !surfaceId) {
      setSubscribed(false);
      setSubscribeFailed(false);
      return;
    }

    setSubscribeFailed(false);
    const controller = new AbortController();
    const offEvent = wsClient.onEvent((eventName, data) => {
      if (eventName !== RPC_EVENTS.TERMINAL_UPDATE) return;
      onReplayPayload(data as TerminalReplayPayload);
    });

    const mobileDims =
      measureMobileGrid() ??
      computeMobileGridDimensions({
        viewportWidth: 0,
        viewportHeight: 0,
        cellWidth: 0,
        cellHeight: 0,
      });
    const initialMode = getViewportMode();

    wsClient
      .call(RPC_METHODS.TERMINAL_SUBSCRIBE, {
        surface_id: surfaceId,
        client_id: clientIdRef.current,
        mode: initialMode,
        columns: initialMode === "mobile" ? mobileDims.cols : undefined,
        rows: initialMode === "mobile" ? mobileDims.rows : undefined,
        max_scrollback_rows: 500,
      })
      .then(() => {
        if (!controller.signal.aborted) {
          setSubscribed(true);
          setSubscribeFailed(false);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.warn("Terminal subscribe failed, using fallback replay:", err);
        setSubscribed(false);
        setSubscribeFailed(true);
      });

    const clientId = clientIdRef.current;
    return () => {
      isMountedRef.current = false;
      controller.abort();
      offEvent();
      setSubscribed(false);
      if (wsClient.getState() === "connected" && wsClient.getEndpoint() === mountedEndpoint) {
        if (getViewportMode() === "mobile") {
          void wsClient
            .call(RPC_METHODS.TERMINAL_VIEWPORT, {
              surface_id: surfaceId,
              client_id: clientId,
              mode: "desktop",
              clear: true,
            })
            .catch(() => {});
        }
        void wsClient
          .call(RPC_METHODS.TERMINAL_UNSUBSCRIBE, { surface_id: surfaceId })
          .catch(() => {});
      }
    };
  }, [connState, surfaceId, getViewportMode, measureMobileGrid, onReplayPayload]);

  // Fallback 1s polling ONLY when `TERMINAL_SUBSCRIBE` failed and connected (zero duplicate mount replay).
  useEffect(() => {
    if (!subscribeFailed || connState !== "connected") return;
    void fetchReplay();
    const interval = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchReplay();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [subscribeFailed, connState, fetchReplay]);

  return {
    subscribed,
    isMountedRef,
    syncViewportToGateway,
    fetchReplay,
  };
}
