import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { writeCachedChatTranscript } from "../components/chat/chatTranscriptCache";
import {
  PENDING_SEND_TTL_MS,
  PENDING_WORKING_GRACE_MS,
  type ChatSessionAction,
  type ChatSessionState,
} from "../domain/chat/transcriptReducer";
import type { WireSessionFrame } from "../domain/chat/types";
import { RPC_EVENTS, RPC_METHODS, type SurfaceNode } from "../protocol/rpc";
import { wsClient, type ConnectionState } from "../transport/wsClient";

export function useChatSubscription({
  connState,
  surface,
  surfaceKey,
  agentSid,
  agentKd,
  hasAgent,
  cacheIdentity,
  chatSubscriptionEnabled,
  state,
  stateRef,
  isFollowingRef,
  dispatch,
}: {
  connState: ConnectionState;
  surface: SurfaceNode;
  surfaceKey: string;
  agentSid?: string;
  agentKd?: string;
  hasAgent: boolean;
  cacheIdentity: string;
  chatSubscriptionEnabled: boolean;
  state: ChatSessionState;
  stateRef: React.RefObject<ChatSessionState>;
  isFollowingRef: React.RefObject<boolean>;
  dispatch: Dispatch<ChatSessionAction>;
}) {
  const [subscribed, setSubscribed] = useState(false);
  const subscribedRef = useRef(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    subscribedRef.current = subscribed;
  }, [subscribed]);

  // Persist confirmed turns to the two-tier session cache.
  useEffect(() => {
    if (!state.snapshotConfirmed || !hasAgent) return;
    writeCachedChatTranscript(
      cacheIdentity,
      {
        turns: state.turns,
        hasMore: state.hasMoreHistory,
        beforeOffset: state.beforeOffset,
        lifecycleState: state.lifecycleState,
        isWorking: state.isWorking,
        activityText: state.activityText,
        savedAt: Date.now(),
      },
      !state.isWorking,
    );
  }, [
    cacheIdentity,
    hasAgent,
    state.snapshotConfirmed,
    state.turns,
    state.hasMoreHistory,
    state.beforeOffset,
    state.lifecycleState,
    state.isWorking,
    state.activityText,
  ]);

  // Deterministic timer ticks for `withinGrace` (20s) and `pendingSends` TTL (90s) expiry.
  useEffect(() => {
    if (state.pendingSends.length === 0) return;
    const now = Date.now();
    let nextWakeMs = PENDING_SEND_TTL_MS + 250;
    for (const p of state.pendingSends) {
      const graceRem = PENDING_WORKING_GRACE_MS - (now - p.createdAt);
      const ttlRem = PENDING_SEND_TTL_MS - (now - p.createdAt);
      if (graceRem > 0 && graceRem < nextWakeMs) nextWakeMs = graceRem + 25;
      if (ttlRem > 0 && ttlRem < nextWakeMs) nextWakeMs = ttlRem + 25;
    }
    const timer = setTimeout(
      () => dispatch({ type: "TICK_NOW", now: Date.now() }),
      Math.max(50, nextWakeMs),
    );
    return () => clearTimeout(timer);
  }, [state.pendingSends, state.now, dispatch]);

  const applyFrame = useCallback(
    (frame: WireSessionFrame) => {
      dispatch({
        type: "APPLY_SESSION_FRAME",
        frame,
        isFollowing: isFollowingRef.current,
        now: Date.now(),
      });
    },
    [dispatch, isFollowingRef],
  );

  const loadSessionTurns = useCallback(
    async (requestedMaxTurns?: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const resp = await wsClient.call<WireSessionFrame>(RPC_METHODS.CHAT_READ_SESSION, {
          surface_id: surfaceKey,
          session_id: agentSid,
          agent_kind: agentKd,
          max_turns: requestedMaxTurns ?? stateRef.current.turnLimit,
        });
        if (resp) applyFrame(resp);
      } catch (err) {
        console.warn("Failed to load session turns:", err);
      } finally {
        loadingRef.current = false;
      }
    },
    [surfaceKey, agentSid, agentKd, stateRef, applyFrame],
  );

  useEffect(() => {
    if (connState !== "connected" || !chatSubscriptionEnabled) {
      setSubscribed(false);
      return;
    }
    const controller = new AbortController();
    let fallbackPoll: ReturnType<typeof setInterval> | null = null;
    const startFallbackPolling = () => {
      if (controller.signal.aborted || fallbackPoll !== null) return;
      void loadSessionTurns();
      fallbackPoll = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          void loadSessionTurns();
        }
      }, 2000);
    };

    const initialGuardTimer = setTimeout(() => {
      if (!stateRef.current.snapshotSeen && !controller.signal.aborted) {
        void loadSessionTurns();
      }
    }, 1500);

    const offEvent = wsClient.onEvent((event, data) => {
      if (event !== RPC_EVENTS.CHAT_UPDATE) return;
      const snap = data as WireSessionFrame;
      if (snap.surface_id && snap.surface_id !== surface.id && snap.surface_id !== surface.ref) {
        return;
      }
      clearTimeout(initialGuardTimer);
      applyFrame(snap);
    });

    wsClient
      .call<WireSessionFrame & { subscribed?: boolean }>(RPC_METHODS.CHAT_SUBSCRIBE, {
        surface_id: surfaceKey,
        session_id: agentSid,
        agent_kind: agentKd,
        max_turns: stateRef.current.turnLimit,
        capabilities: { delta: true },
      })
      .then((res) => {
        if (controller.signal.aborted) return;
        setSubscribed(true);
        if (res && (Array.isArray(res.turns) || res.startup_dialog !== undefined)) {
          clearTimeout(initialGuardTimer);
          applyFrame(res);
        }
      })
      .catch((err) => {
        console.warn("Chat subscribe failed, falling back to polling:", err);
        clearTimeout(initialGuardTimer);
        startFallbackPolling();
      });

    const mountedEndpoint = wsClient.getEndpoint();
    return () => {
      controller.abort();
      clearTimeout(initialGuardTimer);
      if (fallbackPoll !== null) clearInterval(fallbackPoll);
      offEvent();
      setSubscribed(false);
      if (wsClient.getEndpoint() === mountedEndpoint && wsClient.getState() === "connected") {
        void wsClient
          .call(RPC_METHODS.CHAT_UNSUBSCRIBE, { surface_id: surfaceKey })
          .catch(() => {});
      }
    };
  }, [
    connState,
    chatSubscriptionEnabled,
    surfaceKey,
    surface.id,
    surface.ref,
    agentSid,
    agentKd,
    state.sessionEpoch,
    stateRef,
    applyFrame,
    loadSessionTurns,
  ]);

  // One-shot startup-dialog probe on plain shell surfaces.
  useEffect(() => {
    if (connState !== "connected" || hasAgent) return;
    void loadSessionTurns(1);
  }, [connState, hasAgent, surfaceKey, loadSessionTurns]);

  return {
    subscribedRef,
    loadSessionTurns,
  };
}
